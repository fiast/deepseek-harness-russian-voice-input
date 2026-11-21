import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Host half of the Russian voice-input plugin.
 *
 * Owns the local runtime (virtual environment, faster-whisper, model cache) and exposes two
 * same-origin HTTP routes under the Harness web server: a status snapshot the composer polls
 * and a transcription endpoint that accepts one recording and returns its text. Neither route
 * touches the Session or submits anything; the browser inserts the returned text into the draft.
 */

const TRANSCRIBE_PATH = '/plugins/ru-voice/transcribe'
const STATUS_PATH = '/plugins/ru-voice/status'
const MAX_AUDIO_BYTES = 32 * 1024 * 1024
const MAX_RECORDING_SECONDS = 240
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
const MODEL_TIMEOUT_MS = 40 * 60 * 1000
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000
const WARM_IDLE_MS = 10 * 60 * 1000

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('Запись слишком большая'), { status: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

/** Run one child process, collecting bounded output and enforcing a deadline. */
function runCommand(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    options.onChild?.(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = options.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill()
          } catch {
            // Already exited.
          }
          finish(new Error('Превышено время ожидания операции с распознаванием'))
        }, options.timeoutMs)
      : undefined
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > 200000) stdout = stdout.slice(-200000)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (code === 0) finish(undefined, { stdout, stderr })
      else finish(new Error((stderr || stdout).trim() || `Процесс завершился с кодом ${code}`))
    })
    child.stdin.on('error', () => {
      // The process may exit before stdin is consumed.
    })
    if (options.input === undefined) child.stdin.end()
    else child.stdin.end(options.input)
  })
}

class VoiceRuntime {
  constructor(config) {
    this.config = config
    this.dataRoot = config.dataRoot || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-data', 'ru-voice')
    this.venvDir = join(this.dataRoot, 'venv')
    this.python = process.platform === 'win32' ? join(this.venvDir, 'Scripts', 'python.exe') : join(this.venvDir, 'bin', 'python')
    this.stamp = join(this.dataRoot, 'runtime-ready.json')
    this.script = fileURLToPath(new URL('./transcribe.py', import.meta.url))
    this.state = { ready: false, phase: 'idle', message: '', error: undefined, model: config.model || 'small' }
    this.task = undefined
    this.queue = Promise.resolve()
    this.children = new Set()
    this.warm = undefined
    this.disposed = false
  }

  snapshot() {
    return {
      ready: this.state.ready,
      phase: this.state.phase,
      message: this.state.message,
      error: this.state.error,
      model: this.state.model,
      warm: this.warm !== undefined && this.warm.closed !== true,
    }
  }

  publish(phase, message, ready = false, error) {
    if (this.disposed) return
    this.state = { ...this.state, phase, message, ready, error }
  }

  env() {
    return {
      ...process.env,
      HF_HOME: join(this.dataRoot, 'hf'),
      HF_HUB_DISABLE_TELEMETRY: '1',
      HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      RU_VOICE_MODEL: this.state.model,
      RU_VOICE_MODEL_DIR: join(this.dataRoot, 'models'),
      RU_VOICE_THREADS: String(this.config.threads ?? 0),
      RU_VOICE_BEAM: String(this.config.beamSize ?? 1),
    }
  }

  tracked(executable, args, options) {
    return runCommand(executable, args, {
      ...options,
      onChild: (child) => {
        this.children.add(child)
        child.once('exit', () => this.children.delete(child))
        options?.onChild?.(child)
      },
    })
  }

  async basePython() {
    const candidates = []
    if (this.config.pythonPath) candidates.push(this.config.pythonPath)
    if (process.env.RU_VOICE_PYTHON) candidates.push(process.env.RU_VOICE_PYTHON)
    candidates.push(join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
    candidates.push(process.platform === 'win32' ? 'python.exe' : 'python3')
    candidates.push('python')
    for (const candidate of candidates) {
      if (candidate.includes('\\') || candidate.includes('/')) {
        if (!existsSync(candidate)) continue
      }
      try {
        const result = await this.tracked(candidate, ['-c', 'import sys; print(sys.version_info[0])'], { timeoutMs: 20000 })
        if (result.stdout.trim() === '3') return candidate
      } catch {
        // Try the next interpreter.
      }
    }
    throw new Error('Не найден Python 3. Укажите pythonPath в настройках плагина.')
  }

  async depsReady() {
    if (!existsSync(this.python)) return false
    try {
      // PyAV 19 removed `metadata_errors`, which faster-whisper 1.2 still passes to av.open().
      await this.tracked(
        this.python,
        ['-c', 'import faster_whisper, av; assert int(av.__version__.split(".")[0]) < 19'],
        { timeoutMs: 60000 },
      )
      return true
    } catch {
      return false
    }
  }

  ensure() {
    if (this.state.ready) return Promise.resolve()
    if (this.task !== undefined) return this.task
    this.task = this.install().finally(() => {
      this.task = undefined
    })
    return this.task
  }

  async install() {
    try {
      if (existsSync(this.stamp) && existsSync(this.python) && !this.state.error) {
        this.publish('ready', 'Распознавание готово', true)
        this.prewarm()
        return
      }
      this.publish('checking', 'Проверяю локальное окружение…')
      const base = await this.basePython()
      if (!existsSync(this.python)) {
        this.publish('venv', 'Создаю виртуальное окружение Python…')
        await mkdir(this.dataRoot, { recursive: true })
        await this.tracked(base, ['-m', 'venv', this.venvDir], { timeoutMs: INSTALL_TIMEOUT_MS })
      }
      if (!(await this.depsReady())) {
        this.publish('installing', 'Устанавливаю faster-whisper (только при первой настройке)…')
        await this.tracked(this.python, ['-m', 'pip', 'install', '--disable-pip-version-check', 'faster-whisper', 'av<19'], {
          timeoutMs: INSTALL_TIMEOUT_MS,
          env: this.env(),
        })
      }
      this.publish('model', 'Загружаю модель Whisper small (около 500 МБ, один раз)…')
      await this.tracked(this.python, [this.script, '--warmup'], {
        timeoutMs: MODEL_TIMEOUT_MS,
        env: this.env(),
      })
      await writeFile(this.stamp, JSON.stringify({ model: this.state.model, createdAt: new Date().toISOString() }), 'utf8')
      this.publish('ready', 'Распознавание готово', true)
    } catch (error) {
      this.publish('error', 'Не удалось подготовить распознавание', false, messageOf(error))
      return
    }
    // Keep one model-loaded Python process ready so the first dictated phrase does not pay the load cost.
    this.prewarm()
  }

  /** Start the warm process shortly after activation without blocking it. */
  prewarm() {
    setTimeout(() => {
      if (this.disposed) return
      try {
        this.warmWorker()
      } catch {
        // The next real request retries.
      }
    }, 500).unref?.()
  }

  enqueue(task) {
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async transcribe(audio) {
    if (!this.state.ready) {
      void this.ensure()
      const error = new Error(this.state.message || 'Распознавание ещё готовится')
      error.status = 503
      throw error
    }
    return await this.enqueue(async () => {
      const payload = await this.requestWarm(audio)
      return {
        text: String(payload.text ?? ''),
        durationSeconds: Number(payload.durationSeconds ?? 0),
        elapsedSeconds: Number(payload.elapsedSeconds ?? 0),
      }
    })
  }

  /** Spawn or reuse the one model-loaded recognition process. */
  warmWorker() {
    if (this.warm !== undefined && this.warm.closed !== true) return this.warm
    const child = spawn(this.python, [this.script, '--server'], {
      cwd: this.dataRoot,
      env: this.env(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const warm = { child, buffer: '', stderr: '', pending: new Map(), nextId: 1, closed: false, idleTimer: undefined }
    const failPending = (reason) => {
      for (const entry of warm.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error(reason))
      }
      warm.pending.clear()
    }
    child.stdout.on('data', (chunk) => {
      warm.buffer += String(chunk)
      let newline
      while ((newline = warm.buffer.indexOf('\n')) >= 0) {
        const line = warm.buffer.slice(0, newline).trim()
        warm.buffer = warm.buffer.slice(newline + 1)
        if (line === '') continue
        let payload
        try {
          payload = JSON.parse(line)
        } catch {
          continue
        }
        const entry = warm.pending.get(payload.id)
        if (entry === undefined) continue
        warm.pending.delete(payload.id)
        clearTimeout(entry.timer)
        if (payload.ok === true) entry.resolve(payload)
        else entry.reject(new Error(payload.error || 'Не удалось распознать речь'))
      }
    })
    child.stderr.on('data', (chunk) => {
      warm.stderr = (warm.stderr + String(chunk)).slice(-4000)
    })
    child.once('exit', () => {
      warm.closed = true
      clearTimeout(warm.idleTimer)
      if (this.warm === warm) this.warm = undefined
      failPending(warm.stderr.trim() || 'Процесс распознавания завершился')
    })
    child.once('error', (error) => {
      warm.stderr = messageOf(error)
    })
    child.stdin.on('error', () => {
      // The process may exit before stdin is consumed.
    })
    this.children.add(child)
    child.once('exit', () => this.children.delete(child))
    this.warm = warm
    return warm
  }

  /** Send one recording to the warm process and await its JSON answer. */
  requestWarm(audio) {
    const runtime = this
    const warm = runtime.warmWorker()
    const id = warm.nextId++
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        warm.pending.delete(id)
        reject(new Error('Распознавание заняло слишком много времени'))
      }, TRANSCRIBE_TIMEOUT_MS)
      warm.pending.set(id, { resolve, reject, timer })
      try {
        warm.child.stdin.write(JSON.stringify({ id, audio: audio.toString('base64') }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        warm.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    const scheduleIdle = () => {
      clearTimeout(warm.idleTimer)
      warm.idleTimer = setTimeout(() => {
        if (runtime.warm !== warm || warm.pending.size > 0) return
        runtime.warm = undefined
        try {
          warm.child.kill()
        } catch {
          // Already exited.
        }
      }, WARM_IDLE_MS)
      warm.idleTimer.unref?.()
    }
    answer.then(scheduleIdle, scheduleIdle)
    return answer
  }

  async dispose() {
    this.disposed = true
    if (this.warm !== undefined) {
      clearTimeout(this.warm.idleTimer)
      this.warm = undefined
    }
    for (const child of this.children) {
      try {
        child.kill()
      } catch {
        // Already exited.
      }
    }
    this.children.clear()
  }
}

export function apply(ctx, config = {}) {
  const runtime = new VoiceRuntime(config)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            sendJson(response, 405, { error: 'Метод не поддерживается' })
            return
          }
          sendJson(response, 200, runtime.snapshot())
        },
      }),
    'ru-voice-input: status route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: TRANSCRIBE_PATH,
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: 'Метод не поддерживается' })
            return
          }
          const type = String(request.headers['content-type'] || '')
          if (!type.startsWith('audio/') && !type.startsWith('application/octet-stream')) {
            sendJson(response, 415, { error: 'Ожидается аудиофайл' })
            return
          }
          try {
            const audio = await readBody(request, MAX_AUDIO_BYTES)
            if (audio.length < 512) {
              sendJson(response, 400, { error: 'Запись слишком короткая' })
              return
            }
            const result = await runtime.transcribe(audio)
            sendJson(response, 200, { ...result, maxSeconds: MAX_RECORDING_SECONDS })
          } catch (error) {
            const status = typeof error?.status === 'number' ? error.status : 500
            sendJson(response, status, { error: messageOf(error), ...runtime.snapshot() })
          }
        },
      }),
    'ru-voice-input: transcription route',
  )

  ctx.effect(() => {
    void runtime.ensure()
    return () => runtime.dispose()
  }, 'ru-voice-input: runtime')
}

export const inject = ['webServer']
