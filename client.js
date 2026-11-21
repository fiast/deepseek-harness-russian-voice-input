window.__ModuleLoader__.load({
	id: '@local/ru-voice-input',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		const NS = 'ru-voice-input'
		const SLOT = 'conversation.input.right'
		const STATUS_URL = '/plugins/ru-voice/status'
		const TRANSCRIBE_URL = '/plugins/ru-voice/transcribe'

		/** Phrase boundaries: silence after speech closes one recorded phrase. */
		const SILENCE_MS = 700
		const MIN_SPEECH_MS = 900
		const MAX_PHRASE_MS = 12000
		const SILENT_DISCARD_MS = 4000
		const CALIBRATION_MS = 500

		/** Copy for every locale this bundle ships; registered into the Host locale service. */
		const DICTS = {
			en: {
				'button.start': 'Dictate in Russian (phrases appear as you pause)',
				'button.stop': 'Finish dictation',
				'button.busy': 'Recognising the last phrases…',
				'button.preparing': 'Speech recognition is being prepared',
				'notice.unsupported': 'Microphone recording is unavailable in this browser',
				'notice.notAllowed': 'Microphone access was denied',
				'notice.microphone': 'No microphone is available',
				'notice.recording': 'Recording failed',
				'notice.server': 'The local recognition service did not respond',
				'notice.preparing': 'The recognition model is still being prepared, try again shortly',
				'notice.insertRejected': 'The draft cannot accept text right now',
			},
			ru: {
				'button.start': 'Диктовка на русском — фразы появляются на паузах',
				'button.stop': 'Закончить диктовку',
				'button.busy': 'Распознаю последние фразы…',
				'button.preparing': 'Распознавание ещё готовится',
				'notice.unsupported': 'Запись с микрофона недоступна в этом браузере',
				'notice.notAllowed': 'Доступ к микрофону запрещён',
				'notice.microphone': 'Микрофон недоступен',
				'notice.recording': 'Ошибка записи',
				'notice.server': 'Локальная служба распознавания не ответила',
				'notice.preparing': 'Модель распознавания ещё готовится, попробуйте чуть позже',
				'notice.insertRejected': 'Поле ввода сейчас не принимает текст',
			},
			zh: {
				'button.start': '俄语语音输入（停顿后逐句出现）',
				'button.stop': '结束语音输入',
				'button.busy': '正在识别最后的句子…',
				'button.preparing': '语音识别正在准备',
				'notice.unsupported': '此浏览器无法录制麦克风',
				'notice.notAllowed': '麦克风访问被拒绝',
				'notice.microphone': '麦克风不可用',
				'notice.recording': '录音失败',
				'notice.server': '本地识别服务未响应',
				'notice.preparing': '识别模型仍在准备，请稍后再试',
				'notice.insertRejected': '输入框当前无法接收文字',
			},
		}

		const CSS = `
.ruv-mic {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
}
.ruv-mic__btn {
	position: relative;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	padding: 0;
	border: 0;
	border-radius: 8px;
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	cursor: pointer;
	transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.ruv-mic__btn:hover:not(:disabled) {
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-primary);
}
.ruv-mic__btn:focus-visible {
	outline: 2px solid var(--dsw-alias-brand-primary);
	outline-offset: 1px;
}
.ruv-mic__btn[data-state="live"] {
	color: var(--dsw-alias-state-error-primary);
}
.ruv-mic__btn[data-state="preparing"] {
	opacity: 0.5;
}
.ruv-mic__btn:disabled {
	cursor: default;
	opacity: 0.6;
}
.ruv-mic__btn svg {
	display: block;
	width: 16px;
	height: 16px;
}
.ruv-mic__ring {
	position: absolute;
	inset: 0;
	border: 1px solid currentColor;
	border-radius: inherit;
	pointer-events: none;
	animation: ruv-mic-ring 1500ms ease-out infinite;
}
.ruv-mic__spinner {
	position: absolute;
	inset: 0;
	border: 2px solid transparent;
	border-top-color: currentColor;
	border-right-color: currentColor;
	border-radius: 50%;
	pointer-events: none;
	animation: ruv-mic-spin 900ms linear infinite;
}
.ruv-mic__notice {
	max-width: 190px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 11.5px;
	line-height: 1.4;
	color: var(--dsw-alias-state-error-primary);
}
@keyframes ruv-mic-ring {
	0% { opacity: 0.65; transform: scale(0.85); }
	60% { opacity: 0; transform: scale(1.5); }
	100% { opacity: 0; transform: scale(1.5); }
}
@keyframes ruv-mic-spin {
	to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
	.ruv-mic__ring, .ruv-mic__spinner { animation: none; }
	.ruv-mic__spinner { border-color: currentColor; opacity: 0.35; }
}
`

		/** Microphone glyph. */
		function MicrophoneIcon() {
			return h(
				'svg',
				{
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
					focusable: 'false',
				},
				h('path', { d: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z' }),
				h('path', { d: 'M19 11v1a7 7 0 0 1-14 0v-1' }),
				h('path', { d: 'M12 19v3' }),
			)
		}

		/** Collapse whitespace and keep punctuation attached to the preceding word. */
		function normalize(text) {
			return String(text)
				.replace(/\s+/g, ' ')
				.replace(/\s+([,.!?;:…])/g, '$1')
				.trim()
		}

		function pickMimeType() {
			if (typeof window.MediaRecorder === 'undefined') return ''
			const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
			for (const type of candidates) {
				try {
					if (window.MediaRecorder.isTypeSupported(type)) return type
				} catch {
					// Ignore an implementation that rejects the query.
				}
			}
			return ''
		}

		function emptySession() {
			return {
				active: false,
				stream: null,
				audio: null,
				analyser: null,
				source: null,
				vadBuffer: null,
				interval: undefined,
				recorder: null,
				ending: false,
				chunks: [],
				speech: false,
				lastSpeech: 0,
				startedAt: 0,
				calibrating: false,
				calibration: [],
				calibrationStart: 0,
				threshold: 0.02,
				pending: 0,
				insertedAny: false,
				chain: Promise.resolve(),
				finishing: false,
			}
		}

		function VoiceButton(props) {
			const inputActions = props.inputActions
			const t = typeof props.t === 'function' ? props.t : (key) => key

			const [phase, setPhase] = React.useState('idle')
			const [ready, setReady] = React.useState(true)
			const [notice, setNotice] = React.useState(null)

			const session = React.useRef(emptySession())
			const mountedRef = React.useRef(true)

			React.useEffect(() => {
				mountedRef.current = true
				return () => {
					mountedRef.current = false
				}
			}, [])

			React.useEffect(() => {
				let alive = true
				let timer
				const poll = async () => {
					try {
						const response = await fetch(STATUS_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
						const value = await response.json()
						if (!alive) return
						setReady(value.ready === true)
					} catch {
						if (alive) setReady(false)
					}
					if (alive) timer = setTimeout(poll, 5000)
				}
				poll()
				return () => {
					alive = false
					clearTimeout(timer)
				}
			}, [])

			React.useEffect(() => {
				if (!notice) return undefined
				const timer = setTimeout(() => setNotice(null), 8000)
				return () => clearTimeout(timer)
			}, [notice])

			function stopCapture() {
				const s = session.current
				clearInterval(s.interval)
				s.interval = undefined
				if (s.analyser !== null) {
					try {
						s.analyser.disconnect()
					} catch {
						// Already disconnected.
					}
				}
				if (s.source !== null) {
					try {
						s.source.disconnect()
					} catch {
						// Already disconnected.
					}
				}
				if (s.audio !== null) {
					try {
						void s.audio.close()
					} catch {
						// Already closed.
					}
				}
				s.analyser = null
				s.source = null
				s.audio = null
				s.vadBuffer = null
				if (s.stream !== null) {
					for (const track of s.stream.getTracks()) {
						try {
							track.stop()
						} catch {
							// Already stopped.
						}
					}
				}
				s.stream = null
			}

			function finishStop() {
				const s = session.current
				if (s.finishing) return
				s.finishing = true
				s.active = false
				stopCapture()
				if (mountedRef.current) setPhase('idle')
			}

			function insertPhrase(text) {
				const s = session.current
				const value = s.insertedAny && !/^[.,!?;:…]/.test(text) ? ' ' + text : text
				const canInsert =
					inputActions &&
					typeof inputActions.captureInsertion === 'function' &&
					typeof inputActions.insertText === 'function'
				if (!canInsert) {
					if (mountedRef.current) setNotice({ text: t('notice.insertRejected') })
					return
				}
				const span = inputActions.captureInsertion()
				let accepted = false
				try {
					accepted = inputActions.insertText(value, span) === true
				} catch {
					accepted = false
				}
				if (accepted) s.insertedAny = true
				else if (mountedRef.current) setNotice({ text: t('notice.insertRejected') })
			}

			function enqueuePhrase(blob) {
				const s = session.current
				s.pending += 1
				s.chain = s.chain.then(async () => {
					try {
						const response = await fetch(TRANSCRIBE_URL, {
							method: 'POST',
							headers: { 'content-type': blob.type || 'application/octet-stream' },
							body: blob,
						})
						let value = {}
						try {
							value = await response.json()
						} catch {
							value = {}
						}
						if (!mountedRef.current) return
						if (!response.ok) {
							if (response.status === 503) setReady(false)
							setNotice({ text: value.error || t('notice.server') })
							return
						}
						const text = normalize(value.text || '')
						if (text !== '') insertPhrase(text)
					} catch (error) {
						if (error && error.name === 'AbortError') return
						if (mountedRef.current) setNotice({ text: t('notice.server') })
					} finally {
						s.pending -= 1
						if (!s.active && s.pending === 0 && !s.finishing) finishStop()
					}
				})
			}

			function startSegment() {
				const s = session.current
				if (!s.active || s.stream === null) return
				const mimeType = pickMimeType()
				let recorder
				try {
					recorder = mimeType === '' ? new window.MediaRecorder(s.stream) : new window.MediaRecorder(s.stream, { mimeType })
				} catch {
					if (mountedRef.current) setNotice({ text: t('notice.unsupported') })
					finishStop()
					return
				}
				s.recorder = recorder
				s.chunks = []
				s.speech = false
				s.ending = false
				s.startedAt = performance.now()
				s.lastSpeech = 0
				recorder.ondataavailable = (event) => {
					if (event.data && event.data.size > 0) s.chunks.push(event.data)
				}
				recorder.onstop = () => {
					const blob = new Blob(s.chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
					const spoke = s.speech
					s.chunks = []
					s.recorder = null
					s.ending = false
					if (spoke && blob.size > 1200) enqueuePhrase(blob)
					if (s.active) {
						startSegment()
					} else if (s.pending === 0 && !s.finishing) {
						finishStop()
					}
				}
				recorder.onerror = () => {
					if (mountedRef.current) setNotice({ text: t('notice.recording') })
					if (s.recorder === recorder) {
						s.ending = true
						try {
							recorder.stop()
						} catch {
							s.recorder = null
							finishStop()
						}
					}
				}
				try {
					recorder.start(250)
				} catch {
					s.recorder = null
					if (mountedRef.current) setNotice({ text: t('notice.recording') })
					finishStop()
				}
			}

			function tick() {
				const s = session.current
				const analyser = s.analyser
				if (analyser === null) return
				const buffer = s.vadBuffer || (s.vadBuffer = new Float32Array(analyser.fftSize))
				analyser.getFloatTimeDomainData(buffer)
				let sum = 0
				for (let index = 0; index < buffer.length; index += 1) {
					const value = buffer[index]
					sum += value * value
				}
				const rms = Math.sqrt(sum / buffer.length)
				const now = performance.now()
				if (s.calibrating) {
					s.calibration.push(rms)
					if (now - s.calibrationStart > CALIBRATION_MS) {
						const average = s.calibration.reduce((total, value) => total + value, 0) / s.calibration.length
						s.threshold = Math.min(0.06, Math.max(0.006, average * 3))
						s.calibrating = false
					}
					return
				}
				if (rms > s.threshold) {
					s.speech = true
					s.lastSpeech = now
				}
				const recorder = s.recorder
				if (recorder === null || s.ending) return
				const duration = now - s.startedAt
				const silence = now - (s.lastSpeech || 0)
				const closeBecauseSilence = s.speech && duration > MIN_SPEECH_MS && silence > SILENCE_MS
				const closeBecauseLong = duration > MAX_PHRASE_MS
				const discardSilence = !s.speech && duration > SILENT_DISCARD_MS
				if (closeBecauseSilence || closeBecauseLong || discardSilence) {
					s.ending = true
					try {
						recorder.stop()
					} catch {
						s.recorder = null
						s.ending = false
						if (s.active) startSegment()
						else if (s.pending === 0 && !s.finishing) finishStop()
					}
				}
			}

			async function startSession() {
				const s = session.current
				if (s.active) return
				if (!ready) {
					setNotice({ text: t('notice.preparing') })
					return
				}
				if (typeof window.MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
					setNotice({ text: t('notice.unsupported') })
					return
				}
				let stream
				try {
					stream = await navigator.mediaDevices.getUserMedia({
						audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
					})
				} catch (error) {
					const name = error && error.name
					setNotice({ text: name === 'NotAllowedError' || name === 'SecurityError' ? t('notice.notAllowed') : t('notice.microphone') })
					return
				}
				if (!mountedRef.current) {
					for (const track of stream.getTracks()) track.stop()
					return
				}
				const Ctx = window.AudioContext || window.webkitAudioContext
				try {
					s.audio = new Ctx()
					await s.audio.resume()
					s.source = s.audio.createMediaStreamSource(stream)
					s.analyser = s.audio.createAnalyser()
					s.analyser.fftSize = 2048
					s.source.connect(s.analyser)
				} catch {
					for (const track of stream.getTracks()) track.stop()
					setNotice({ text: t('notice.unsupported') })
					return
				}
				s.stream = stream
				s.active = true
				s.pending = 0
				s.finishing = false
				s.insertedAny = false
				s.calibrating = true
				s.calibration = []
				s.calibrationStart = performance.now()
				s.threshold = 0.02
				s.chain = Promise.resolve()
				s.vadBuffer = new Float32Array(s.analyser.fftSize)
				s.interval = setInterval(tick, 60)
				setNotice(null)
				setPhase('live')
				startSegment()
			}

			function stopSession() {
				const s = session.current
				if (!s.active) return
				s.active = false
				clearInterval(s.interval)
				s.interval = undefined
				if (s.pending > 0) setPhase('stopping')
				const recorder = s.recorder
				if (recorder === null) {
					if (s.pending === 0) finishStop()
					else setPhase('stopping')
					return
				}
				if (!s.ending) {
					s.ending = true
					try {
						recorder.stop()
					} catch {
						s.recorder = null
						s.ending = false
						if (s.pending === 0) finishStop()
					}
				}
			}

			const toggle = () => {
				const s = session.current
				if (s.active) stopSession()
				else if (phase === 'stopping') return
				else void startSession()
			}

			React.useEffect(
				() => () => {
					const s = session.current
					s.active = false
					clearInterval(s.interval)
					const recorder = s.recorder
					s.recorder = null
					if (recorder !== null && recorder.state !== 'inactive') {
						recorder.onstop = null
						try {
							recorder.stop()
						} catch {
							// Already stopped.
						}
					}
					stopCapture()
				},
				[],
			)

			const label =
				phase === 'live'
					? t('button.stop')
					: phase === 'stopping'
						? t('button.busy')
						: ready
							? t('button.start')
							: t('button.preparing')
			const state = phase === 'live' ? 'live' : phase === 'stopping' ? 'stopping' : ready ? 'idle' : 'preparing'

			return h(
				React.Fragment,
				null,
				h('style', { key: 'style' }, CSS),
				h(
					'span',
					{ className: 'ruv-mic' },
					notice
						? h(
								'span',
								{ key: 'notice', className: 'ruv-mic__notice', role: 'status', title: notice.text },
								notice.text,
							)
						: null,
					h(
						'button',
						{
							key: 'button',
							type: 'button',
							className: 'ruv-mic__btn',
							'data-state': state,
							'aria-label': label,
							'aria-pressed': phase === 'live',
							title: notice ? notice.text : label,
							onClick: toggle,
							disabled: phase === 'stopping',
						},
						MicrophoneIcon(),
						phase === 'live' ? h('span', { className: 'ruv-mic__ring', 'aria-hidden': true }) : null,
						phase === 'stopping' ? h('span', { className: 'ruv-mic__spinner', 'aria-hidden': true }) : null,
					),
				),
			)
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				for (const [locale, dict] of Object.entries(DICTS)) {
					ctx.effect(() => ctx.locale.register(NS, locale, dict), 'ru-voice-input: locale ' + locale)
				}

				const t = ctx.locale.bind(NS)

				ctx.slots.inject(SLOT, () =>
					ctx.slots.register(
						{ name: SLOT, id: 'ru-voice-input', order: 0 },
						(slotProps) => h(VoiceButton, Object.assign({}, slotProps, { t })),
					),
				)
			},
		}
	},
})
