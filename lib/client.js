
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-session-recap',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var RecapIcon
    // 图标名随 DSH 版本改名：0.1.6 用 …16 后缀，0.2.x 改为 …Regular（0.2.0-rc.1 起移除 …16）。
    // 依次回退，缺失时不影响斜杠命令本身（icon 可选）。
    try {
      var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      RecapIcon = primitives.IconListPenOutline16 || primitives.IconListPenOutlineRegular || primitives.IconListPenOutline
    } catch (_) { RecapIcon = undefined }
    var NS = '@dsh-external/dsh-session-recap'
    // 生成中或有可见提示时快速拉取，其余时间降低频率。
    var POLL_ACTIVE_MS = 1500
    var POLL_IDLE_MS = 10000
    var POLL_TIMEOUT_MS = 4000
    // 心跳间隔小于宿主的 45 秒在线租约。
    var PRESENCE_HEARTBEAT_MS = 20000
    var PRESENCE_DEDUPE_MS = 2000
    var manualRequestTimeoutMs = 70000
    var presenceClientId = createPresenceClientId()
    var presenceSequence = 0
    var dismissedStoragePrefix = 'dsh-session-recap:dismissed:'
    var legacyDismissedStoragePrefix = dismissedStoragePrefix

    var css = [
      '.sr-recap-banner{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));display:flex;flex-direction:column;gap:6px;margin:0 auto 6px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:12px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-base,Canvas));color:var(--dsw-alias-label-primary,CanvasText);box-shadow:var(--dsw-shadow-lv1,none);font-size:13px;line-height:1.5}',
      '.sr-recap-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.sr-recap-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-secondary,CanvasText);font-size:11px;font-weight:600;letter-spacing:.03em}',
      '.sr-recap-close{margin-left:auto;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,CanvasText);opacity:.75;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;border-radius:6px}',
      '.sr-recap-close:hover{background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-primary,CanvasText);opacity:1}',
      '.sr-recap-text{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}',
    ].join('\n')
    var styleId = NS + '/recap.css'
    if (typeof document !== 'undefined') {
      var style = document.querySelector('style[data-plugin-css="' + styleId + '"]')
      if (style === null) {
        style = document.createElement('style')
        style.dataset.plugin = NS
        style.dataset.pluginCss = styleId
        document.head.appendChild(style)
      }
      style.textContent = css
    }

    function turnPart(turnSeq) {
      return turnSeq === null || turnSeq === undefined ? 'none' : String(turnSeq)
    }

    function atPart(at) {
      return at === null || at === undefined ? '0' : String(at)
    }

    function sessionStorageKey(sessionId) {
      return dismissedStoragePrefix + encodeURIComponent(String(sessionId))
    }

    function validSessionId(sessionId) {
      return !(sessionId === undefined || sessionId === null || String(sessionId) === '')
    }

    function dismissalKey(sessionId, turnSeq, at) {
      if (!validSessionId(sessionId)) return null
      return String(sessionId) + ':' + turnPart(turnSeq) + ':' + atPart(at)
    }

    function legacyStorageKey(sessionId, turnSeq) {
      return legacyDismissedStoragePrefix + encodeURIComponent(String(sessionId) + ':' + turnPart(turnSeq))
    }

    var dismissedCache = new Map()

    function readStorage(key) {
      if (typeof window === 'undefined') return null
      try { return window.sessionStorage.getItem(key) } catch (_) { return null }
    }

    function writeStorage(key, value) {
      if (typeof window === 'undefined') return
      try { window.sessionStorage.setItem(key, value) } catch (_) {}
    }

    function cachedDismissal(sessionId, key) {
      if (!dismissedCache.has(key)) dismissedCache.set(key, readStorage(key))
      return dismissedCache.get(key)
    }

    function wasDismissed(sessionId, turnSeq, at) {
      if (!validSessionId(sessionId)) return false
      var expected = turnPart(turnSeq) + ':' + atPart(at)
      var key = sessionStorageKey(sessionId)
      if (cachedDismissal(sessionId, key) === expected) return true
      return cachedDismissal(sessionId, legacyStorageKey(sessionId, turnSeq)) === '1'
    }

    function rememberDismissed(sessionId, turnSeq, at) {
      if (!validSessionId(sessionId)) return
      var value = turnPart(turnSeq) + ':' + atPart(at)
      var key = sessionStorageKey(sessionId)
      dismissedCache.set(key, value)
      writeStorage(key, value)
    }

    function validRecap(value) {
      if (value === null || typeof value !== 'object') return null
      if (typeof value.text !== 'string' || value.text === '') return null
      if (value.turnSeq !== null && value.turnSeq !== undefined && (typeof value.turnSeq !== 'number' || !Number.isSafeInteger(value.turnSeq) || value.turnSeq < 0)) return null
      return {
        text: value.text,
        turnSeq: value.turnSeq === undefined ? null : value.turnSeq,
        at: typeof value.at === 'number' ? value.at : 0,
      }
    }

    function isStale(recap, turnSeq, turnOpen) {
      if (recap === null) return false
      if (turnOpen === true) return true
      if (recap.turnSeq === null) return false
      return typeof turnSeq === 'number' && turnSeq > recap.turnSeq
    }

    function loadable(value) {
      return value !== null && value !== undefined && typeof value === 'object'
    }

    var notices = new Map()
    var noticeWatchers = new Set()
    function publishNotice(sessionId, message) {
      var key = String(sessionId)
      if (typeof message === 'string' && message !== '') notices.set(key, message)
      else notices.delete(key)
      noticeWatchers.forEach(function (watcher) { watcher() })
    }
    var pollers = new Map()
    var pendingManual = new Map()

    function createPresenceClientId() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      } catch (_) {}
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
    }

    function requestManualRecap(session, t) {
      var sessionId = session === undefined || session === null ? undefined : session.sessionId
      if (!validSessionId(sessionId)) return
      var key = String(sessionId)
      var url = '/api/dsh-session-recap?sessionId=' + encodeURIComponent(key) + '&action=generate'
      pendingManual.set(key, (pendingManual.get(key) ?? 0) + 1)
      var poll = pollers.get(key)
      if (poll !== undefined) poll()
      fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(manualRequestTimeoutMs) })
        .then(function (response) { return response.json().catch(function () { return null }) })
        .then(function (body) {
          if (body !== null && body.ok === true) {
            publishNotice(key, null)
            var again = pollers.get(key)
            if (again !== undefined) again()
            return
          }
          publishNotice(key, body !== null && typeof body.error === 'string' && body.error !== '' ? body.error : t('failed'))
        })
        .catch(function () { publishNotice(key, t('failed')) })
        .finally(function () {
          var left = (pendingManual.get(key) ?? 1) - 1
          if (left <= 0) pendingManual.delete(key)
          else pendingManual.set(key, left)
        })
    }

    function isWindowActive() {
      if (typeof document === 'undefined') return true
      return !document.hidden && (typeof document.hasFocus !== 'function' || document.hasFocus())
    }

    function reportPresence(sessionId, active) {
      var sessionKey = validSessionId(sessionId) ? String(sessionId) : ''
      var state = active ? 'active' : 'away'
      var now = Date.now()
      if (presenceSession === sessionKey && presenceState === state && now - presenceAt < PRESENCE_DEDUPE_MS) return
      presenceSession = sessionKey
      presenceState = state
      presenceAt = now
      presenceSequence += 1
      var url = '/api/dsh-session-recap?scope=app&presence=' + state
        + '&clientId=' + encodeURIComponent(presenceClientId)
        + '&seq=' + String(presenceSequence)
      if (sessionKey !== '') url += '&sessionId=' + encodeURIComponent(sessionKey)
      try {
        fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true }).catch(function () {})
      } catch (_) {}
    }

    var presenceSession = null
    var presenceState = null
    var presenceAt = 0
    var presenceSessions = new Map()

    function trackAppPresence() {
      if (typeof document === 'undefined') return undefined
      function report(active) {
        if (presenceSessions.size === 0) reportPresence(null, active)
        else presenceSessions.forEach(function (_count, sessionId) { reportPresence(sessionId, active) })
      }
      function syncPresence() { report(isWindowActive()) }
      function markAway() { report(false) }
      presenceState = null
      syncPresence()
      var heartbeat = setInterval(syncPresence, PRESENCE_HEARTBEAT_MS)
      document.addEventListener('visibilitychange', syncPresence)
      window.addEventListener('focus', syncPresence)
      window.addEventListener('blur', markAway)
      window.addEventListener('pagehide', markAway)
      window.addEventListener('pageshow', syncPresence)
      return function () {
        clearInterval(heartbeat)
        document.removeEventListener('visibilitychange', syncPresence)
        window.removeEventListener('focus', syncPresence)
        window.removeEventListener('blur', markAway)
        window.removeEventListener('pagehide', markAway)
        window.removeEventListener('pageshow', syncPresence)
        markAway()
      }
    }

    function RecapBanner(props) {
      var sessionId = props.sessionId
      var sessionKey = !validSessionId(sessionId) ? '' : String(sessionId)
      var recapState = react.useState({ owner: '', value: null, stale: false })
      var loaded = recapState[0]
      var setLoaded = recapState[1]
      var recap = loaded.owner === sessionKey && loaded.stale !== true ? loaded.value : null
      var noticeState = react.useState(0)
      var setNoticeTick = noticeState[1]
      react.useEffect(function () {
        var watcher = function () { setNoticeTick(function (value) { return value + 1 }) }
        noticeWatchers.add(watcher)
        return function () { noticeWatchers.delete(watcher) }
      }, [])
      var notice = notices.get(sessionKey) || null
      var dismissedKeyState = react.useState(null)
      var dismissedKey = dismissedKeyState[0]
      var setDismissedKey = dismissedKeyState[1]

      react.useEffect(function () {
        if (sessionKey === '') {
          setLoaded({ owner: '', value: null, stale: false })
          return undefined
        }
        var cancelled = false
        var inFlight = false
        var controller = null
        var timer = null
        var latest = { value: null, stale: false }

        function cadence() {
          if (notices.get(sessionKey) !== undefined) return POLL_ACTIVE_MS
          if ((pendingManual.get(sessionKey) ?? 0) > 0) return POLL_ACTIVE_MS
          if (latest.value !== null && latest.stale !== true) return POLL_ACTIVE_MS
          return POLL_IDLE_MS
        }

        function schedule(delay) {
          if (cancelled) return
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(load, delay)
        }

        function load() {
          if (cancelled) return
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          if (typeof document !== 'undefined' && document.hidden === true) return
          if (inFlight) {
            schedule(POLL_ACTIVE_MS)
            return
          }
          inFlight = true
          controller = new AbortController()
          var pollAbort = setTimeout(function () { controller.abort() }, POLL_TIMEOUT_MS)
          var url = '/api/dsh-session-recap?sessionId=' + encodeURIComponent(sessionKey)
          fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
            .then(function (response) {
              if (!response.ok) return null
              return response.json()
            })
            .then(function (body) {
              if (cancelled || !loadable(body)) return
              if (typeof body.manualRequestTimeoutMs === 'number' && body.manualRequestTimeoutMs > 0) {
                manualRequestTimeoutMs = body.manualRequestTimeoutMs
              }
              var value = validRecap(body.recap)
              var stale = isStale(value, typeof body.turnSeq === 'number' ? body.turnSeq : null, body.turnOpen === true)
              latest = { value: value, stale: stale }
              setLoaded({ owner: sessionKey, value: value, stale: stale })
            })
            .catch(function () {})
            .finally(function () {
              clearTimeout(pollAbort)
              inFlight = false
              schedule(cadence())
            })
        }

        load()
        pollers.set(sessionKey, load)
        var wake = function () { load() }
        document.addEventListener('visibilitychange', wake)
        window.addEventListener('focus', wake)
        return function () {
          cancelled = true
          if (pollers.get(sessionKey) === load) pollers.delete(sessionKey)
          if (timer !== null) clearTimeout(timer)
          document.removeEventListener('visibilitychange', wake)
          window.removeEventListener('focus', wake)
          if (controller !== null) controller.abort()
        }
      }, [sessionKey])

      react.useEffect(function () {
        setDismissedKey(null)
      }, [sessionId])

      react.useEffect(function () {
        if (loaded.owner !== sessionKey || loaded.stale !== true || loaded.value === null) return
        rememberDismissed(sessionId, loaded.value.turnSeq, loaded.value.at)
      }, [loaded, sessionId, sessionKey])

      var text = recap !== null ? recap.text : null
      var turnSeq = recap !== null ? recap.turnSeq : null
      var at = recap !== null ? recap.at : null
      var currentKey = dismissalKey(sessionId, turnSeq, at)

      react.useEffect(function () {
        if (typeof document === 'undefined' || sessionKey === '') return undefined
        presenceSessions.set(sessionKey, (presenceSessions.get(sessionKey) || 0) + 1)
        reportPresence(sessionKey, isWindowActive())
        return function () {
          var remaining = presenceSessions.get(sessionKey) - 1
          if (remaining === 0) presenceSessions.delete(sessionKey)
          else presenceSessions.set(sessionKey, remaining)
        }
      }, [sessionKey])

      var showRecap = text !== null && currentKey !== null && dismissedKey !== currentKey && !wasDismissed(sessionId, turnSeq, at)
      var show = notice !== null || showRecap

      if (!show) return null
      var t = props.t || function (key) { return key }
      return react.createElement('div', { className: 'sr-recap-banner', role: 'note' },
        react.createElement('div', { className: 'sr-recap-head' },
          react.createElement('span', { className: 'sr-recap-badge' }, notice !== null ? t('failed') : t('badge')),
          react.createElement('button', {
            type: 'button',
            className: 'sr-recap-close',
            'aria-label': t('dismiss'),
            title: t('close'),
            onClick: function () {
              if (notice !== null) publishNotice(sessionKey, null)
              if (showRecap) {
                rememberDismissed(sessionId, turnSeq, at)
                setDismissedKey(currentKey)
              }
            },
          }, '\u2715')),
        react.createElement('div', { className: 'sr-recap-text' }, notice !== null ? notice : text))
    }

    var en = {
      badge: 'Recap',
      failed: 'Recap failed',
      dismiss: 'Dismiss session recap',
      close: 'Dismiss',
      commandLabel: 'Recap',
      commandDescription: 'Summarize the current task, progress, key findings, and next action.',
    }
    var zh = {
      badge: '回顾',
      failed: '回顾失败',
      dismiss: '关闭会话回顾',
      close: '关闭',
      commandLabel: '会话回顾',
      commandDescription: '总结当前任务、进展、关键发现和下一步。',
    }
    var inject = ['locale', 'slots']

    function apply(ctx) {
      ctx.effect(trackAppPresence, 'dsh-session-recap: app presence')
      ctx.effect(function () { return ctx.locale.register(NS, { en: en, zh: zh }) }, 'dsh-session-recap: dictionaries')
      var t = ctx.locale.bind(NS)
      ctx.inject(['commandUi'], function (scope) {
        var command = scope.get('commandUi')
        if (command === undefined) return
        scope.effect(function () {
          return command.register({
            name: 'recap',
            label: function () { return t('commandLabel') },
            description: function () { return t('commandDescription') },
            icon: RecapIcon,
            available: function () { return true },
            ui: {
              kind: 'action',
              run: function (session) { requestManualRecap(session, t) },
            },
          })
        }, 'dsh-session-recap: /recap contribution')
      })
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({ name: 'conversation.input.dock', id: 'recap', locale: NS }, function (props) {
          return react.createElement(RecapBanner, Object.assign({}, props, { t: t }))
        })
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
