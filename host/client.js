// Pocket Harness settings card: shows the pairing code and keeps it fresh.
//
// The browser bundle. The Host serves the ticket at PAIR_PATH; this file draws it
// as a QR code and re-asks every ten minutes, which is exactly how long the Host
// keeps a secret alive. Re-asking sooner would show a code nobody has rotated
// yet; re-asking later would leave a dead one on screen.
//
// Constraints from the Harness client plugin guide, kept because breaking them
// makes a card that belongs to the host look like it belongs to nothing:
//   - one module loader registration whose id is the package name,
//   - React comes from the module table, never from a bundled copy,
//   - no DOM writes outside the component, no iframe surveying our own page,
//   - colours come from the --dsw-alias-* tokens, not from literals.
window.__ModuleLoader__.load({
  id: 'dsh-pocketharness-host',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PAIR_PATH = '/api/pocket-harness/pair'
    /** The Host rotates the secret on this cadence; the card follows it. */
    const REFRESH_MS = 10 * 60 * 1000
    /** Long enough to notice a lapsed code, short enough not to be a clock. */
    const CLOCK_MS = 1000
    const SECTION_ID = 'pocket-harness'

    const CSS = [
      '.ph-card{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;padding:4px 0 2px}',
      '.ph-qr{background:#fff;padding:12px;border-radius:12px;line-height:0;flex:0 0 auto;box-shadow:0 0 0 1px var(--dsw-alias-border-subtle,rgba(0,0,0,.08))}',
      '.ph-qr svg{display:block}',
      '.ph-body{flex:1 1 200px;min-width:180px;font-size:13px;line-height:1.65;color:var(--dsw-alias-text-primary,inherit)}',
      '.ph-title{font-size:14px;font-weight:600;margin:0 0 2px}',
      '.ph-hint{margin:0 0 10px;color:var(--dsw-alias-text-secondary,inherit);opacity:.8}',
      '.ph-row{display:flex;justify-content:space-between;gap:12px;padding:3px 0}',
      '.ph-key{color:var(--dsw-alias-text-secondary,inherit);opacity:.7}',
      '.ph-val{font-variant-numeric:tabular-nums;text-align:right;word-break:break-all}',
      '.ph-code{margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-fill-subtle,rgba(0,0,0,.04));font-size:11px;word-break:break-all;color:var(--dsw-alias-text-secondary,inherit);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.ph-empty{font-size:13px;color:var(--dsw-alias-text-secondary,inherit);opacity:.8}',
      '.ph-bigger{margin-top:12px;font-size:12px}',
      '.ph-bigger a{color:var(--dsw-alias-text-link,inherit);text-decoration:underline}',
      '.ph-source{margin-top:14px;font-size:11px;color:var(--dsw-alias-text-secondary,inherit);opacity:.62}',
    ].join('')

    /**
     * How many screen pixels one QR module gets.
     *
     * This is the whole reason the code used to be unscannable: a 542-byte ticket
     * is a version 16 symbol at level L, so 81 modules fitted into a fixed 188px
     * box left 2.3px per module. Cameras need roughly six. The card therefore
     * sizes the code from the matrix instead of the other way round, and an SVG
     * at an integer multiple keeps every module on a whole pixel boundary.
     */
    const MODULE_PX = 6
    /** Below this a scanner has nothing to lock onto; above it the card stops fitting. */
    const MIN_SIDE_PX = 240
    const MAX_SIDE_PX = 600

    function sideFor(size) {
      if (!Number.isFinite(size) || size <= 0) return MIN_SIDE_PX
      const wanted = size * MODULE_PX
      return Math.max(MIN_SIDE_PX, Math.min(MAX_SIDE_PX, wanted))
    }

    function remaining(expiresAt, now) {
      const expires = Date.parse(expiresAt ?? '')
      if (!Number.isFinite(expires)) return null
      return Math.max(0, expires - now)
    }

    /** `9:59`, or `0:00` once the code is gone. */
    function clock(ms) {
      if (ms === null) return '—'
      const minutes = Math.floor(ms / 60000)
      const seconds = Math.floor((ms % 60000) / 1000)
      return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`
    }

    /**
     * The QR, drawn by the Host.
     *
     * The matrix arrives as the same `'M<c> <r>h1v1h-1z'` path the page uses,
     * because an 81x81 code is 6561 rectangles if it is drawn one module per
     * element and one path otherwise. The side is computed from the matrix so the
     * modules stay large enough for a camera, not capped by a fixed box.
     */
    function Qr({ path, size }) {
      if (typeof path !== 'string' || path.length === 0) return null
      const side = sideFor(size)
      return h(
        'svg',
        {
          viewBox: `0 0 ${size} ${size}`,
          width: side,
          height: side,
          role: 'img',
          'aria-label': '配对二维码',
          shapeRendering: 'crispEdges',
        },
        h('path', { d: path, fill: '#000' }),
      )
    }

    function Row({ label, children, mono }) {
      return h(
        'div',
        { className: 'ph-row' },
        h('span', { className: 'ph-key' }, label),
        h('span', { className: mono ? 'ph-val ph-code' : 'ph-val' }, children),
      )
    }

    /**
     * The card.
     *
     * State is one snapshot plus one tick counter, which keeps the render path
     * pure: the fetch decides what the code is, the tick only decides how much of
     * it is left, and neither can make the other's token appear twice.
     */
    function PairingCard() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [now, setNow] = React.useState(() => Date.now())
      /** Bumped to ask again; the fetch effect depends on it. */
      const [asking, setAsking] = React.useState(0)
      /** The expiry already chased, so a dead Host cannot become a request loop. */
      const chased = React.useRef(null)

      React.useEffect(() => {
        let live = true
        const read = async () => {
          try {
            const response = await fetch(`${PAIR_PATH}?format=json`, { cache: 'no-store' })
            if (!response.ok) throw new Error(`the Host answered ${response.status}`)
            const next = await response.json()
            if (live) {
              setSnapshot(next)
              setFailure(null)
            }
          } catch (error) {
            if (live) setFailure(error.message)
          }
        }
        void read()
        const rotation = window.setInterval(read, REFRESH_MS)
        return () => {
          live = false
          window.clearInterval(rotation)
        }
      }, [asking])

      React.useEffect(() => {
        const tick = window.setInterval(() => setNow(Date.now()), CLOCK_MS)
        return () => window.clearInterval(tick)
      }, [])

      // The Host rotates on its own clock, so a card mounted halfway through a
      // window would otherwise sit at 0:00 until the next poll. Ask once the
      // countdown runs out, and once per ticket so a stuck Host is not hammered.
      const left = snapshot === null ? null : remaining(snapshot.expiresAt, now)
      React.useEffect(() => {
        if (left !== 0) return undefined
        const expiry = snapshot?.expiresAt ?? null
        if (chased.current === expiry) return undefined
        chased.current = expiry
        const timer = window.setTimeout(() => setAsking(count => count + 1), 1500)
        return () => window.clearTimeout(timer)
      }, [left, snapshot])

      if (failure !== null) {
        return h('p', { className: 'ph-empty' }, `读不到配对码：${failure}`)
      }
      if (snapshot === null || snapshot.ready !== true) {
        return h('p', { className: 'ph-empty' }, '链接服务还没起来，稍等片刻。')
      }

      return h(
        'div',
        { className: 'ph-card' },
        h('div', { className: 'ph-qr' }, h(Qr, { path: snapshot.path, size: snapshot.size })),
        h(
          'div',
          { className: 'ph-body' },
          h('p', { className: 'ph-title' }, '用手机扫码配对'),
          h(
            'p',
            { className: 'ph-hint' },
            '打开 App，点「扫码配对」，对准左边的二维码。扫一次就够了：之后在同一个 Wi-Fi 下直连，出门走中继。',
          ),
          h(Row, { label: '这台电脑' }, snapshot.name ?? 'Pocket Harness Host'),
          h(Row, { label: '局域网地址' }, (snapshot.endpoints ?? []).join('、') || '（暂无）'),
          // Only when the Host says so. An older Host omits the field, and
          // "only on this network" printed over a working relay would send
          // people chasing a bug that is not there.
          typeof snapshot.relay === 'boolean'
            ? h(Row, { label: '外网可达' }, snapshot.relay ? '是（经中继）' : '否（只在这个网络里）')
            : null,
          h(Row, { label: '剩余', mono: true }, clock(remaining(snapshot.expiresAt, now))),
          // A code that fills the card is still small on a high-DPI laptop; the
          // page draws a bigger one with no neighbouring text to trip a scanner.
          h(
            'p',
            { className: 'ph-bigger' },
            h('a', { href: PAIR_PATH, target: '_blank', rel: 'noreferrer' }, '扫不出来？打开大图'),
          ),
        ),
      )
    }

    /** Registers the card once per page, under its own slot and style block. */
    function apply(ctx) {
      if (ctx.slots === undefined) return
      const register = () =>
        ctx.slots.register({ name: 'settings.section', id: SECTION_ID, order: 12, label: '手机配对' }, () =>
          h(React.Fragment, null, h('style', null, CSS), h(PairingCard)),
        )
      ctx.slots.inject('settings.section', register)
    }

    return { inject: ['slots'], apply }
  },
})
