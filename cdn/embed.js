/**
 * Ackvyn CRM embed — floating / inline chat widget.
 * Loads public site settings, presence, live chat WS, offline intake form.
 *
 * data-site   required
 * data-crm    Worker API origin (required when script is not on the Worker CDN)
 * data-api    alias of data-crm
 * data-mode   float | inline
 * data-target CSS selector for inline (default #ackvyn-crm-chat)
 */
;(function () {
  var DEFAULT_CRM_API = ''
  var script =
    document.currentScript ||
    document.querySelector('script[src*="embed.js"][data-site]')
  if (!script) return

  var site = script.getAttribute('data-site')
  if (!site) {
    console.warn('[Ackvyn CRM] embed.js missing data-site')
    return
  }

  function resolveCrmBase(el) {
    var attr = (
      el.getAttribute('data-crm') ||
      el.getAttribute('data-api') ||
      ''
    ).replace(/\/$/, '')
    if (attr) return attr
    try {
      var u = new URL(el.src)
      if (/\.workers\.dev$/i.test(u.hostname)) return u.origin
    } catch (e) {}
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING: hardcoded shared Worker default
    // return 'https://ackvyn-crm.ackvyn.workers.dev'
    // NEW CODE - TESTING: CDN hosts require data-crm (each operator’s Worker)
    console.warn(
      '[Ackvyn CRM] embed.js missing data-crm — set data-crm to your Worker origin',
    )
    return DEFAULT_CRM_API
  }

  var mode = script.getAttribute('data-mode') || 'float'
  var target = script.getAttribute('data-target') || '#ackvyn-crm-chat'
  var base = resolveCrmBase(script)
  if (!base) return
  var api = base + '/v1/' + site
  var VISITOR_KEY = 'ackvyn-crm-visitor-id:' + site
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // var ENRICH_KEY = 'ackvyn-crm-visitor-enrich:'

  var defaultWidget = {
    accent: '#3db8a0',
    position: 'bottom-right',
    greeting: 'Hi — thanks for stopping by. How can we help?',
    launcherLabel: 'Chat',
    avatarUrl: '',
    offlineMessage:
      "We're away right now. Leave a message and we'll get back to you.",
    showAgentNames: true,
    offlineFormWhenAway: true,
  }

  window.__ACKVYN_CRM__ = { site: site, mode: mode, base: base, target: target }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function readVisitorId() {
    try {
      return localStorage.getItem(VISITOR_KEY)
    } catch (e) {
      return null
    }
  }

  function storeVisitorId(id) {
    try {
      localStorage.setItem(VISITOR_KEY, id)
    } catch (e) {}
  }

  function wsUrl(path) {
    var u = new URL(api + path)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return u.toString()
  }

  function mountRoot() {
    if (mode === 'inline') {
      var el = document.querySelector(target)
      if (!el) {
        console.warn('[Ackvyn CRM] inline target not found:', target)
        return null
      }
      el.innerHTML = ''
      return el
    }
    // Avoid duplicate float widgets (stale script + new script)
    var existing = document.getElementById('ackvyn-crm-float-root')
    if (existing) existing.remove()
    var wrap = document.createElement('div')
    wrap.id = 'ackvyn-crm-float-root'
    document.body.appendChild(wrap)
    return wrap
  }

  function buildUi(root, widget) {
    var accent = widget.accent || defaultWidget.accent
    var side = widget.position === 'bottom-left' ? 'left' : 'right'
    var open = false
    var panel = document.createElement('div')
    var launcher = document.createElement('button')
    var msgsEl = document.createElement('div')
    var formEl = document.createElement('form')
    var input = document.createElement('input')
    var offlineBox = document.createElement('form')
    var chatId = null
    var chatWs = null
    var visitorWs = null
    var agentsOnline = 0
    // NEW CODE - TESTING: keep CRM presence alive while the widget is loaded
    var presenceVisitorId = null
    var presenceIntervalMs = 45000
    var presenceTimer = null
    var presenceReconnectTimer = null
    var lastPresenceAt = 0

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING: no align — launcher jumps to
    // the left edge of the panel when the wider chat box opens
    // root.style.cssText = 'position:fixed;' + side + ':1rem;bottom:1rem;…'
    // NEW CODE - TESTING: keep launcher on the same corner as when closed
    root.style.cssText =
      mode === 'float'
        ? 'position:fixed;' +
          side +
          ':1rem;bottom:1rem;z-index:2147483000;font:14px/1.45 system-ui,sans-serif;display:flex;flex-direction:column;align-items:' +
          (side === 'left' ? 'flex-start' : 'flex-end')
        : 'font:14px/1.45 system-ui,sans-serif;max-width:24rem'

    launcher.type = 'button'
    var launcherLabel = widget.launcherLabel || 'Chat'
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // launcher.setAttribute('aria-label', widget.launcherLabel || 'Chat')
    // launcher.textContent = widget.launcherLabel || 'Chat'
    // NEW CODE - TESTING: label when closed; down-arrow when open
    launcher.setAttribute('aria-label', launcherLabel)
    launcher.textContent = launcherLabel
    launcher.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;gap:0.5rem;min-width:2.75rem;padding:0.75rem 1rem;border:0;border-radius:0.375rem;background:' +
      accent +
      ';color:#0e1217;font:600 14px system-ui,sans-serif;cursor:pointer'

    // NEW CODE - TESTING: launcher wrap + unread badge + attention toast (no message body)
    var unreadCount = 0
    var toastHideTimer = null
    var notifyAudioCtx = null
    var launcherWrap = document.createElement('div')
    launcherWrap.style.cssText =
      mode === 'float'
        ? 'position:relative;display:inline-flex;flex-direction:column;align-items:' +
          (side === 'left' ? 'flex-start' : 'flex-end')
        : 'display:none'
    var toast = document.createElement('button')
    toast.type = 'button'
    toast.style.cssText =
      'display:none;position:absolute;bottom:calc(100% + 0.5rem);' +
      (side === 'left' ? 'left:0;' : 'right:0;') +
      'max-width:min(14rem,calc(100vw - 2.5rem));padding:0.55rem 0.85rem;border:1px solid #2a3441;border-radius:0.5rem;background:#161c24;color:#e9edf2;text-align:center;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,0.35);font:600 13px/1.3 system-ui,sans-serif;z-index:2'
    toast.setAttribute('aria-live', 'polite')
    var badge = document.createElement('span')
    badge.style.cssText =
      'display:none;position:absolute;top:-0.35rem;right:-0.35rem;min-width:1.15rem;height:1.15rem;padding:0 0.3rem;border-radius:999px;background:#e5484d;color:#fff;font:700 0.65rem/1.15rem system-ui,sans-serif;text-align:center;pointer-events:none;z-index:3'
    launcherWrap.appendChild(toast)
    launcherWrap.appendChild(launcher)
    launcherWrap.appendChild(badge)

    function clearAgentNotify() {
      unreadCount = 0
      badge.style.display = 'none'
      badge.textContent = ''
      toast.style.display = 'none'
      toast.replaceChildren()
      if (toastHideTimer) {
        clearTimeout(toastHideTimer)
        toastHideTimer = null
      }
    }

    function playAgentNotifySound() {
      try {
        var Ctx =
          window.AudioContext ||
          window.webkitAudioContext
        if (!Ctx) return
        if (!notifyAudioCtx) notifyAudioCtx = new Ctx()
        if (notifyAudioCtx.state === 'suspended') {
          void notifyAudioCtx.resume()
        }
        var ctx = notifyAudioCtx
        var t0 = ctx.currentTime
        function beep(start, freq, dur, peak) {
          var g = ctx.createGain()
          g.gain.setValueAtTime(0.0001, start)
          g.gain.exponentialRampToValueAtTime(peak, start + 0.015)
          g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
          g.connect(ctx.destination)
          var o = ctx.createOscillator()
          o.type = 'sine'
          o.frequency.setValueAtTime(freq, start)
          o.connect(g)
          o.start(start)
          o.stop(start + dur + 0.02)
        }
        beep(t0, 880, 0.14, 0.28)
        beep(t0 + 0.12, 1174.7, 0.22, 0.24)
      } catch (e) {}
    }

    // Browsers require a gesture before Web Audio will play
    function unlockNotifyAudio() {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext
        if (!Ctx) return
        if (!notifyAudioCtx) notifyAudioCtx = new Ctx()
        if (notifyAudioCtx.state === 'suspended') void notifyAudioCtx.resume()
      } catch (e) {}
    }
    window.addEventListener('pointerdown', unlockNotifyAudio, { once: true })
    window.addEventListener('keydown', unlockNotifyAudio, { once: true })

    function showAgentNotify() {
      if (mode !== 'float' || open) return
      unreadCount += 1
      badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount)
      badge.style.display = 'block'
      launcher.setAttribute(
        'aria-label',
        launcherLabel + ' (' + unreadCount + ' new)',
      )
      // Attention only — no message preview in the toast
      toast.textContent =
        unreadCount === 1 ? 'New message' : unreadCount + ' new messages'
      toast.style.display = 'block'
      playAgentNotifySound()
      if (toastHideTimer) clearTimeout(toastHideTimer)
      toastHideTimer = setTimeout(function () {
        toast.style.display = 'none'
        toastHideTimer = null
      }, 8000)
    }

    function syncLauncherFace() {
      if (mode !== 'float') return
      if (open) {
        launcher.setAttribute('aria-label', 'Close chat')
        launcher.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'
      } else {
        launcher.setAttribute(
          'aria-label',
          unreadCount
            ? launcherLabel + ' (' + unreadCount + ' new)'
            : launcherLabel,
        )
        launcher.textContent = launcherLabel
      }
    }

    panel.style.cssText =
      'display:none;flex-direction:column;width:min(22rem,calc(100vw - 2rem));height:28rem;margin-bottom:0.75rem;background:#0e1217;color:#e9edf2;border:1px solid #2a3441;border-radius:0.5rem;overflow:hidden'
    if (mode === 'inline') {
      panel.style.display = 'flex'
      panel.style.width = '100%'
      panel.style.height = '26rem'
      panel.style.marginBottom = '0'
      open = true
    }

    var head = document.createElement('div')
    head.style.cssText =
      'display:flex;align-items:center;gap:0.5rem;padding:0.75rem 1rem;background:#161c24;border-bottom:1px solid #2a3441'
    if (widget.avatarUrl) {
      var img = document.createElement('img')
      img.src = widget.avatarUrl
      img.alt = ''
      img.width = 28
      img.height = 28
      img.style.cssText = 'border-radius:999px;object-fit:cover'
      head.appendChild(img)
    }
    var title = document.createElement('div')
    title.style.cssText = 'flex:1;font-weight:600'
    title.textContent = 'Chat'
    head.appendChild(title)
    var status = document.createElement('span')
    status.style.cssText = 'font-size:11px;color:#9aa5b4'
    status.textContent = '…'
    head.appendChild(status)
    panel.appendChild(head)

    msgsEl.style.cssText =
      'flex:1;overflow:auto;padding:0.75rem;display:flex;flex-direction:column;gap:0.5rem'
    panel.appendChild(msgsEl)

    offlineBox.style.cssText = 'display:none;padding:0.75rem;border-top:1px solid #2a3441'
    offlineBox.innerHTML =
      '<p data-offmsg style="margin:0 0 0.5rem;color:#9aa5b4;font-size:13px"></p>' +
      '<input name="name" placeholder="Name" required style="width:100%;margin:0 0 0.4rem;padding:0.5rem;border-radius:0.375rem;border:1px solid #2a3441;background:#161c24;color:#e9edf2;box-sizing:border-box">' +
      '<input name="email" type="email" placeholder="Email" required style="width:100%;margin:0 0 0.4rem;padding:0.5rem;border-radius:0.375rem;border:1px solid #2a3441;background:#161c24;color:#e9edf2;box-sizing:border-box">' +
      '<textarea name="message" placeholder="Message" required rows="3" style="width:100%;margin:0 0 0.5rem;padding:0.5rem;border-radius:0.375rem;border:1px solid #2a3441;background:#161c24;color:#e9edf2;box-sizing:border-box;resize:vertical"></textarea>' +
      '<button type="submit" style="width:100%;padding:0.55rem;border:0;border-radius:0.375rem;background:' +
      accent +
      ';color:#0e1217;font-weight:600;cursor:pointer">Send message</button>'
    offlineBox.querySelector('[data-offmsg]').textContent = widget.offlineMessage
    panel.appendChild(offlineBox)

    formEl.style.cssText =
      'display:flex;gap:0.4rem;padding:0.6rem;border-top:1px solid #2a3441'
    input.type = 'text'
    input.placeholder = 'Message…'
    input.required = true
    input.style.cssText =
      'flex:1;padding:0.5rem;border-radius:0.375rem;border:1px solid #2a3441;background:#161c24;color:#e9edf2'
    var sendBtn = document.createElement('button')
    sendBtn.type = 'submit'
    sendBtn.textContent = 'Send'
    sendBtn.style.cssText =
      'padding:0.5rem 0.75rem;border:0;border-radius:0.375rem;background:' +
      accent +
      ';color:#0e1217;font-weight:600;cursor:pointer'
    formEl.appendChild(input)
    formEl.appendChild(sendBtn)
    panel.appendChild(formEl)

    if (mode === 'float') {
      root.appendChild(panel)
      root.appendChild(launcherWrap)
    } else {
      root.appendChild(panel)
    }

    var seenMessageIds = Object.create(null)

    function addBubble(role, body, authorName, messageId) {
      if (messageId) {
        var mid = String(messageId)
        if (seenMessageIds[mid]) return
        seenMessageIds[mid] = true
      }
      var row = document.createElement('div')
      // NEW CODE - TESTING: system greeting — quiet, no "Support" / agent attribution
      if (role === 'system') {
        row.style.cssText =
          'max-width:92%;align-self:center;text-align:center'
        var sys = document.createElement('div')
        sys.style.cssText =
          'padding:0.35rem 0.5rem;color:#9aa5b4;font-size:13px;line-height:1.4;white-space:pre-wrap;word-break:break-word'
        sys.textContent = body
        row.appendChild(sys)
        msgsEl.appendChild(row)
        msgsEl.scrollTop = msgsEl.scrollHeight
        return
      }
      row.style.cssText =
        'max-width:85%;align-self:' +
        (role === 'visitor' ? 'flex-end' : 'flex-start')
      var label = document.createElement('div')
      label.style.cssText =
        'font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:#9aa5b4;margin-bottom:2px'
      if (role === 'agent' && widget.showAgentNames && authorName) {
        label.textContent = authorName
      } else {
        label.textContent = role === 'visitor' ? 'You' : 'Support'
      }
      var bubble = document.createElement('div')
      bubble.style.cssText =
        'padding:0.45rem 0.65rem;border-radius:0.375rem;white-space:pre-wrap;word-break:break-word;' +
        (role === 'visitor'
          ? 'background:' + accent + ';color:#0e1217'
          : 'background:#161c24')
      bubble.textContent = body
      row.appendChild(label)
      row.appendChild(bubble)
      msgsEl.appendChild(row)
      msgsEl.scrollTop = msgsEl.scrollHeight
    }

    function setMode(live) {
      if (live) {
        offlineBox.style.display = 'none'
        formEl.style.display = 'flex'
        status.textContent = agentsOnline > 0 ? 'Online' : 'Chat'
      } else {
        formEl.style.display = 'none'
        offlineBox.style.display = 'block'
        status.textContent = 'Away'
      }
    }

    function ensureGreeting() {
      if (msgsEl.childElementCount === 0 && widget.greeting) {
        addBubble('system', widget.greeting, null)
      }
    }

    async function refreshAgents() {
      try {
        var res = await fetch(api + '/agents/status')
        var data = await res.json()
        agentsOnline = Number(data.onlineAgents || 0)
        var preferOffline =
          widget.offlineFormWhenAway !== false && agentsOnline === 0 && !chatId
        setMode(!preferOffline)
        if (!preferOffline) ensureGreeting()
      } catch (e) {
        setMode(true)
        ensureGreeting()
      }
    }

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING: ensureEnrichment + ipapi.co
    // async function ensureEnrichment(visitorId) { ... }

    async function heartbeat() {
      var visitorId = readVisitorId()
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING: send pagePath on every heartbeat (SPA nav spam)
      // var body = {
      //   visitorId: visitorId,
      //   pagePath: location.pathname || '/',
      //   userAgent: navigator.userAgent,
      // }
      // NEW CODE - TESTING: online keep-alive only — page analytics belong to GA
      var body = {
        visitorId: visitorId,
        userAgent: navigator.userAgent,
      }
      var res = await fetch(api + '/presence/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      var data = await res.json()
      if (data.visitorId) {
        storeVisitorId(data.visitorId)
        presenceVisitorId = data.visitorId
      }
      lastPresenceAt = Date.now()
      return data
    }

    function sendPresencePing() {
      lastPresenceAt = Date.now()
      if (visitorWs && visitorWs.readyState === 1) {
        try {
          visitorWs.send(
            JSON.stringify({
              type: 'presence',
              // OLD CODE - KEEP UNTIL CONFIRMED WORKING:
              // pagePath: location.pathname || '/',
              userAgent: navigator.userAgent,
              clientAt: new Date().toISOString(),
            }),
          )
          return
        } catch (e) {}
      }
      // HTTP fallback when WS is down (still counts as on-site)
      heartbeat().catch(function () {})
    }

    /** Only catch up if the regular keep-alive looks overdue (e.g. timer throttled). */
    function pingIfOverdue() {
      var dueAfter = Math.max(20_000, presenceIntervalMs * 0.9)
      if (!lastPresenceAt || Date.now() - lastPresenceAt >= dueAfter) {
        sendPresencePing()
      }
    }

    function stopPresenceLoop() {
      if (presenceTimer) {
        clearInterval(presenceTimer)
        presenceTimer = null
      }
    }

    function startPresenceLoop(intervalHint) {
      var ms = Number(intervalHint) || presenceIntervalMs
      // Stay under the ~70s offline window
      if (ms < 20000) ms = 20000
      if (ms > 50000) ms = 50000
      presenceIntervalMs = ms
      stopPresenceLoop()
      presenceTimer = setInterval(sendPresencePing, presenceIntervalMs)
    }

    function connectVisitorWs(visitorId) {
      if (!visitorId) return
      presenceVisitorId = visitorId
      if (visitorWs) {
        try {
          visitorWs.onclose = null
          visitorWs.close()
        } catch (e) {}
      }
      visitorWs = new WebSocket(wsUrl('/ws/visitor/' + visitorId))
      visitorWs.onmessage = function (ev) {
        try {
          var data = JSON.parse(ev.data)
          if (data.type === 'hello') {
            if (data.presenceIntervalMs) {
              startPresenceLoop(data.presenceIntervalMs)
            }
            if (data.activeChatId) {
              resumeChat(data.activeChatId)
            }
            return
          }
          if (
            (data.type === 'chat_message' || data.type === 'message') &&
            data.body
          ) {
            // System lines: never open / notify
            if (data.role === 'system') {
              addBubble('system', data.body, null, data.id || null)
              return
            }
            // Real agent reply — notify when closed; don't force-open the panel
            if (
              !open &&
              mode === 'float' &&
              (data.role || 'agent') === 'agent'
            ) {
              // OLD CODE - KEEP UNTIL CONFIRMED WORKING: toggle(true) / always notify
              // showAgentNotify()
              // NEW CODE - TESTING: skip if chat WS already painted this id
              if (!data.id || !seenMessageIds[data.id]) {
                showAgentNotify()
              }
            }
            if (data.chatId && data.chatId !== chatId) {
              resumeChat(data.chatId)
            } else if (data.chatId && !chatWs) {
              resumeChat(data.chatId)
            }
            addBubble(
              data.role || 'agent',
              data.body,
              data.author_name || null,
              data.id || null,
            )
          }
          if (
            (data.type === 'chat_invite' || data.type === 'chat_started') &&
            data.chatId
          ) {
            // Quietly attach chat socket. Never open for agent-driven invites.
            resumeChat(data.chatId)
            // OLD CODE - KEEP UNTIL CONFIRMED WORKING: open on visitor invite
            // var shouldOpen = data.openPanel === true || data.startedBy === 'visitor'
            // NEW CODE - TESTING: visitor may open their own panel; agent path never force-opens
            if (
              data.startedBy === 'visitor' &&
              data.openPanel !== false &&
              !open &&
              mode === 'float'
            ) {
              // Visitor started the chat themselves — panel already opening from their click path usually
              // Do not force-open here either; their UI flow handles it.
            }
          }
        } catch (e) {}
      }
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING: enrichment + profile on open
      // NEW CODE - TESTING: presence on open + periodic keep-alive
      visitorWs.onopen = function () {
        if (!visitorWs || visitorWs.readyState !== 1) return
        sendPresencePing()
        startPresenceLoop(presenceIntervalMs)
      }
      visitorWs.onclose = function () {
        if (!presenceVisitorId) return
        if (presenceReconnectTimer) return
        presenceReconnectTimer = setTimeout(function () {
          presenceReconnectTimer = null
          if (presenceVisitorId) connectVisitorWs(presenceVisitorId)
        }, 3000)
      }
    }

    function loadChatHistory(id) {
      if (!id) return
      fetch(api + '/chats/' + id)
        .then(function (r) {
          return r.json()
        })
        .then(function (data) {
          if (!data || !Array.isArray(data.messages)) return
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING: skip painting when chat closed
          // if (data.chat && data.chat.status === 'closed') { chatId = null; return }
          // NEW CODE - TESTING: always show transcript (closed = history still visible)
          if (data.chat && data.chat.status === 'closed') {
            chatId = data.chat.id || id
            setMode(true)
            // keep messages visible; visitor can still read prior thread
          } else {
            chatId = id
          }
          // CRITICAL: clearing the DOM must also reset dedupe — otherwise every
          // bubble is skipped as a "duplicate" and the widget looks empty.
          Object.keys(seenMessageIds).forEach(function (k) {
            delete seenMessageIds[k]
          })
          msgsEl.innerHTML = ''
          data.messages.forEach(function (m) {
            addBubble(
              m.role || 'agent',
              m.body,
              m.author_name || null,
              m.id || null,
            )
          })
        })
        .catch(function () {})
    }

    function resumeChat(id, opts) {
      if (!id) return
      var forceHistory = opts && opts.forceHistory
      var alreadyLive =
        chatId === id && chatWs && chatWs.readyState === 1
      if (!alreadyLive) {
        connectChatWs(id)
      }
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING: skip history if socket already open
      // if (alreadyLive) return
      // NEW CODE - TESTING: always refresh transcript (esp. when opening the panel)
      loadChatHistory(id)
      void forceHistory
    }

    function connectChatWs(id) {
      chatId = id
      if (chatWs) {
        try {
          chatWs.close()
        } catch (e) {}
      }
      chatWs = new WebSocket(wsUrl('/ws/chat/' + id + '?role=visitor'))
      chatWs.onmessage = function (ev) {
        try {
          var data = JSON.parse(ev.data)
          if (data.type === 'message' && data.body) {
            if (data.role === 'system') {
              addBubble('system', data.body, null, data.id || null)
              return
            }
            if (
              !open &&
              mode === 'float' &&
              (data.role || 'agent') === 'agent'
            ) {
              // OLD CODE - KEEP UNTIL CONFIRMED WORKING: toggle(true)
              // showAgentNotify()
              // NEW CODE - TESTING: skip duplicate from visitor WS
              if (!data.id || !seenMessageIds[data.id]) {
                showAgentNotify()
              }
            }
            addBubble(
              data.role || 'agent',
              data.body,
              data.author_name || null,
              data.id || null,
            )
          }
        } catch (e) {}
      }
      setMode(true)
    }

    async function startChat() {
      var visitorId = readVisitorId()
      if (!visitorId) {
        var hb = await heartbeat()
        visitorId = hb && hb.visitorId
      }
      if (!visitorId) return
      connectVisitorWs(visitorId)
      var res = await fetch(api + '/visitors/' + visitorId + '/start-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startedBy: 'visitor' }),
      })
      var data = await res.json()
      if (data.chatId) {
        connectChatWs(data.chatId)
        // Resumed chats include prior messages
        if (data.resumed) loadChatHistory(data.chatId)
      }
    }

    formEl.addEventListener('submit', function (e) {
      e.preventDefault()
      var text = input.value.trim()
      if (!text) return
      input.value = ''
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING: always paint locally, then WS
      // echo from broadcastChat painted the same visitor message again
      // addBubble('visitor', text, null)
      // if (chatWs && chatWs.readyState === 1) { chatWs.send(...) } else { startChat()… }
      // NEW CODE - TESTING: WS path waits for server echo; HTTP fallback paints once
      function deliver() {
        if (chatWs && chatWs.readyState === 1) {
          chatWs.send(JSON.stringify({ type: 'message', body: text }))
          return
        }
        addBubble('visitor', text, null)
        if (!chatId) return
        fetch(api + '/chats/' + chatId + '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: text, role: 'visitor' }),
        }).catch(function () {})
      }
      if (chatWs && chatWs.readyState === 1) {
        deliver()
      } else {
        startChat().then(deliver)
      }
    })

    offlineBox.addEventListener('submit', function (e) {
      e.preventDefault()
      var fd = new FormData(offlineBox)
      var payload = {
        name: String(fd.get('name') || '').trim(),
        email: String(fd.get('email') || '').trim(),
        message: String(fd.get('message') || '').trim(),
      }
      fetch(api + '/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          return r.json()
        })
        .then(function () {
          offlineBox.innerHTML =
            '<p style="margin:0;color:#9aa5b4;font-size:13px">Thanks — we got your message.</p>'
        })
        .catch(function () {
          alert('Could not send. Try again shortly.')
        })
    })

    function toggle(force) {
      open = force != null ? force : !open
      panel.style.display = open ? 'flex' : 'none'
      if (open) clearAgentNotify()
      syncLauncherFace()
      if (open) {
        refreshAgents()
        // Always re-pull transcript when opening so CRM/agent messages aren't missing
        if (chatId) loadChatHistory(chatId)
        heartbeat()
          .then(function (data) {
            var id = typeof data === 'string' ? data : data && data.visitorId
            if (id) connectVisitorWs(id)
            var resumeId =
              data && typeof data === 'object' ? data.activeChatId : null
            if (resumeId) resumeChat(resumeId, { forceHistory: true })
            else if (chatId) loadChatHistory(chatId)
          })
          .catch(function () {})
      }
    }

    launcher.addEventListener('click', function () {
      toggle()
    })
    toast.addEventListener('click', function () {
      toggle(true)
    })

    window.addEventListener('ackvyn-crm-open-chat', function () {
      toggle(true)
    })

    refreshAgents()
    // Always connect presence so hello can resume an open chat
    heartbeat()
      .then(function (data) {
        var id = typeof data === 'string' ? data : data && data.visitorId
        if (id) connectVisitorWs(id)
        var resumeId =
          data && typeof data === 'object' ? data.activeChatId : null
        if (resumeId) resumeChat(resumeId)
        startPresenceLoop(presenceIntervalMs)
      })
      .catch(function () {})

    setInterval(refreshAgents, 60000)

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING: ping on every focus / pageshow / visible
    // document.addEventListener('visibilitychange', ...)
    // window.addEventListener('pageshow', ...)
    // window.addEventListener('focus', ...)

    // NEW CODE - TESTING: only catch up when the normal keep-alive looks overdue
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') pingIfOverdue()
    })
    window.addEventListener('focus', function () {
      pingIfOverdue()
    })
  }

  fetch(api + '/settings')
    .then(function (r) {
      return r.json()
    })
    .then(function (data) {
      var widget = Object.assign(
        {},
        defaultWidget,
        (data.settings && data.settings.widget) || {},
      )
      var root = mountRoot()
      if (root) buildUi(root, widget)
      window.dispatchEvent(
        new CustomEvent('ackvyn-crm-embed-ready', {
          detail: window.__ACKVYN_CRM__,
        }),
      )
    })
    .catch(function (err) {
      console.warn('[Ackvyn CRM] failed to load settings', err)
      var root = mountRoot()
      if (root) buildUi(root, defaultWidget)
    })
})()
