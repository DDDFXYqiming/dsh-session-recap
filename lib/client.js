// Web client half of @dsh-external/dsh-session-recap.
// It reads the host-owned sidecar snapshot through a same-origin route and
// renders a dismissible away-summary banner in the conversation dock.
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-session-recap',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var NS = '@dsh-external/dsh-session-recap'
    var POLL_MS = 2000
    var POLL_TIMEOUT_MS = 4000
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

    // Identity includes the generation timestamp: /recap commands do not open
    // turns, so several recaps can share one turnSeq anchor. Dismissing one
    // generation must not silence the next.
    function dismissalKey(sessionId, turnSeq, at) {
      if (sessionId === undefined || sessionId === null || String(sessionId) === '') return null
      return String(sessionId) + ':' + turnPart(turnSeq) + ':' + atPart(at)
    }

    function sessionStorageKey(sessionId) {
      return dismissedStoragePrefix + encodeURIComponent(String(sessionId))
    }

    function legacyStorageKey(sessionId, turnSeq) {
      return legacyDismissedStoragePrefix + encodeURIComponent(dismissalKey(sessionId, turnSeq))
    }

    function wasDismissed(sessionId, turnSeq, at) {
      if (sessionId === undefined || sessionId === null || String(sessionId) === '') return false
      if (typeof window === 'undefined') return false
      var expected = turnPart(turnSeq) + ':' + atPart(at)
      try {
        if (window.sessionStorage.getItem(sessionStorageKey(sessionId)) === expected) return true
        // Keep dismissals made by the pre-sidecar client version effective.
        return window.sessionStorage.getItem(legacyStorageKey(sessionId, turnSeq)) === '1'
      } catch (_) {
        return false
      }
    }

    function rememberDismissed(sessionId, turnSeq, at) {
      if (sessionId === undefined || sessionId === null || String(sessionId) === '') return
      if (typeof window === 'undefined') return
      var value = turnPart(turnSeq) + ':' + atPart(at)
      try { window.sessionStorage.setItem(sessionStorageKey(sessionId), value) } catch (_) {}
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

    function isWindowActive() {
      if (typeof document === 'undefined') return true
      return !document.hidden && (typeof document.hasFocus !== 'function' || document.hasFocus())
    }

    function reportPresence(sessionId, active) {
      if (sessionId === undefined || sessionId === null || String(sessionId) === '') return
      var url = '/api/dsh-session-recap?sessionId=' + encodeURIComponent(String(sessionId)) + '&presence=' + (active ? 'active' : 'away')
      try {
        fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true }).catch(function () {})
      } catch (_) {}
    }

    function RecapBanner(props) {
      var sessionId = props.sessionId
      var sessionKey = sessionId === undefined || sessionId === null ? '' : String(sessionId)
      var recapState = react.useState({ owner: '', value: null })
      var loadedRecap = recapState[0]
      var setLoadedRecap = recapState[1]
      var recap = loadedRecap.owner === sessionKey ? loadedRecap.value : null
      var dismissed = react.useState(null)
      var dismissedKey = dismissed[0]
      var setDismissedKey = dismissed[1]
      var shownKey = react.useRef(null)
      var useSession = props.useSession
      var useConversation = props.useConversation
      // Session lifecycle part works on both host generations (pending is
      // absent-safe: newer snapshots may omit it).
      var sessionActivity = useSession(function (snapshot) {
        var pending = Array.isArray(snapshot.pending) ? snapshot.pending.length : ''
        return String(snapshot.running) + ':' + String(pending)
      })
      // Chat timeline part: the chat projection moved out of the Session
      // snapshot into Conversation views ('chat' target). Fall back to the
      // legacy snapshot.chat shape when useConversation is absent (old hosts).
      var chatActivity = useConversation
        ? useConversation(function (conversation) {
            var chat = conversation.views.get('chat')
            var order = chat ? chat.order : []
            var visibleCount = 0
            var lastVisible = ''
            for (var index = 0; index < order.length; index += 1) {
              var key = order[index]
              if (chat.nodes.get(key)?.kind === 'command') continue
              visibleCount += 1
              lastVisible = key
            }
            return String(visibleCount) + ':' + lastVisible
          })
        : useSession(function (snapshot) {
            var chat = snapshot.chat
            if (!chat || !Array.isArray(chat.order)) return ''
            var visibleCount = 0
            var lastVisible = ''
            for (var index = 0; index < chat.order.length; index += 1) {
              var key = chat.order[index]
              if (chat.nodes.get(key)?.kind === 'command') continue
              visibleCount += 1
              lastVisible = key
            }
            return String(visibleCount) + ':' + lastVisible
          })
      var activityKey = sessionActivity + ':' + chatActivity
      var lastActivity = react.useRef(activityKey)

      // The host route is deliberately polled: the HTTP carrier has no
      // projection push channel for plugin-owned sidecar state.
      react.useEffect(function () {
        setLoadedRecap({ owner: sessionKey, value: null })
        if (sessionKey === '') return undefined
        var cancelled = false
        var inFlight = false
        var controller = null
        function load() {
          if (cancelled || inFlight || !isWindowActive()) return
          inFlight = true
          controller = new AbortController()
          // A host hot-reload can abandon an in-flight poll without ever
          // settling the fetch; without a deadline, inFlight stays true and
          // this banner goes permanently deaf. The timeout self-heals.
          var pollAbort = setTimeout(function () { controller.abort() }, POLL_TIMEOUT_MS)
          var url = '/api/dsh-session-recap?sessionId=' + encodeURIComponent(sessionKey)
          fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
            .then(function (response) {
              if (!response.ok) return null
              return response.json()
            })
            .then(function (body) {
              if (cancelled || body === null) return
              setLoadedRecap({ owner: sessionKey, value: validRecap(body.recap) })
            })
            .catch(function () {})
            .finally(function () { clearTimeout(pollAbort); inFlight = false })
        }
        load()
        var timer = setInterval(load, POLL_MS)
        document.addEventListener('visibilitychange', load)
        window.addEventListener('focus', load)
        return function () {
          cancelled = true
          clearInterval(timer)
          document.removeEventListener('visibilitychange', load)
          window.removeEventListener('focus', load)
          if (controller !== null) controller.abort()
        }
      }, [sessionKey])

      react.useEffect(function () {
        setDismissedKey(null)
        shownKey.current = null
        lastActivity.current = activityKey
      }, [sessionId])

      var text = recap !== null ? recap.text : null
      var turnSeq = recap !== null ? recap.turnSeq : null
      var at = recap !== null ? recap.at : null
      var currentKey = dismissalKey(sessionId, turnSeq, at)

      // A new chat message is evidence that the user has returned. Only
      // dismiss a recap that was actually rendered; a hidden-tab recap must
      // survive until the tab becomes visible.
      react.useEffect(function () {
        if (lastActivity.current === activityKey) return
        lastActivity.current = activityKey
        if (text !== null && currentKey !== null && shownKey.current === currentKey && !wasDismissed(sessionId, turnSeq, at)) {
          rememberDismissed(sessionId, turnSeq, at)
          setDismissedKey(currentKey)
        }
      }, [activityKey, text, currentKey, sessionId, turnSeq, at])

      react.useEffect(function () {
        if (typeof document === 'undefined' || sessionKey === '') return undefined
        // Focus only drives host presence reporting (generation trigger); it
        // must NOT gate rendering — that re-hid a visible card on every OS
        // window blur. Delivery-on-return is already handled by the
        // focus-gated poll above.
        function syncPresence() {
          reportPresence(sessionKey, isWindowActive())
        }
        function markAway() {
          reportPresence(sessionKey, false)
        }
        syncPresence()
        document.addEventListener('visibilitychange', syncPresence)
        window.addEventListener('focus', syncPresence)
        window.addEventListener('blur', markAway)
        window.addEventListener('pagehide', markAway)
        return function () {
          document.removeEventListener('visibilitychange', syncPresence)
          window.removeEventListener('focus', syncPresence)
          window.removeEventListener('blur', markAway)
          window.removeEventListener('pagehide', markAway)
          reportPresence(sessionKey, false)
        }
      }, [sessionKey])

      var show = text !== null && currentKey !== null && dismissedKey !== currentKey && !wasDismissed(sessionId, turnSeq, at)
      react.useEffect(function () {
        if (show) shownKey.current = currentKey
      }, [show, currentKey])

      // Hooks above are intentionally unconditional; the slot can briefly
      // exist without a bound session while the conversation tree mounts.
      if (!show) return null
      var t = props.t || function (key) { return key }
      return react.createElement('div', { className: 'sr-recap-banner', role: 'note' },
        react.createElement('div', { className: 'sr-recap-head' },
          react.createElement('span', { className: 'sr-recap-badge' }, t('badge')),
          react.createElement('button', {
            type: 'button',
            className: 'sr-recap-close',
            'aria-label': t('dismiss'),
            title: t('close'),
            onClick: function () {
              rememberDismissed(sessionId, turnSeq, at)
              setDismissedKey(currentKey)
            },
          }, '\u2715')),
        react.createElement('div', { className: 'sr-recap-text' }, text))
    }

    var en = {
      badge: 'Recap',
      dismiss: 'Dismiss session recap',
      close: 'Dismiss',
    }
    var zh = {
      badge: '回顾',
      dismiss: '关闭会话回顾',
      close: '关闭',
    }
    var inject = ['locale', 'slots']

    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(NS, { en: en, zh: zh }) }, 'dsh-session-recap: dictionaries')
      var t = ctx.locale.bind(NS)
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
