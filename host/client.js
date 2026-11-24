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
      '.ph-qr svg{width:188px;height:188px;display:block}',
      '.ph-body{flex:1 1 200px;min-width:180px;font-size:13px;line-height:1.65;color:var(--dsw-alias-text-primary,inherit)}',
      '.ph-title{font-size:14px;font-weight:600;margin:0 0 2px}',
      '.ph-hint{margin:0 0 10px;color:var(--dsw-alias-text-secondary,inherit);opacity:.8}',
      '.ph-row{display:flex;justify-content:space-between;gap:12px;padding:3px 0}',
      '.ph-key{color:var(--dsw-alias-text-secondary,inherit);opacity:.7}',
      '.ph-val{font-variant-numeric:tabular-nums;text-align:right;word-break:break-all}',
      '.ph-code{margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-fill-subtle,rgba(0,0,0,.04));font-size:11px;word-break:break-all;color:var(--dsw-alias-text-secondary,inherit);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.ph-empty{font-size:13px;color:var(--dsw-alias-text-secondary,inherit);opacity:.8}',
      '.ph-source{margin-top:14px;font-size:11px;color:var(--dsw-alias-text-secondary,inherit);opacity:.62}',
    ].join('')

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
     * because a 69x69 code is 4761 rectangles if it is drawn one module per
     * element and one path otherwise. The size is a hint, not a layout decision:
     * the card's CSS decides how big it lands.
     */
    function Qr({ path, size }) {
      if (typeof path !== 'string' || path.length === 0) return null
      return h(
        'svg',
        { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': '配对二维码', shapeRendering: 'crispEdges' },
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
          h('p', { className: 'ph-hint' }, '打开 App，点「扫码配对」，对准左边的二维码。手机要和电脑连同一个 Wi-Fi。'),
          h(Row, { label: '这台电脑' }, snapshot.name ?? 'Pocket Harness Host'),
          h(Row, { label: '局域网地址' }, (snapshot.endpoints ?? []).join('、') || '（暂无）'),
          h(Row, { label: '剩余', mono: true }, clock(remaining(snapshot.expiresAt, now))),
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
