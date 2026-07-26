/**
 * Ackvyn Google Reviews loader — fetches public JSON from the CRM Worker.
 * Does not render a UI; fires an event so any page can build a custom layout.
 *
 * Usage:
 *   <script
 *     src="https://crm.ackvyn.org/cdn/reviews-embed.js"
 *     data-site="your-site-key"
 *     data-crm="https://YOUR-SUBDOMAIN.workers.dev"
 *     async
 *   ></script>
 *   <script>
 *     window.addEventListener('ackvyn-reviews', (e) => {
 *       console.log(e.detail) // { ok, displayName, rating, reviews, ... }
 *     })
 *     // or: window.AckvynReviews.get('your-site-key').then(...)
 *   </script>
 *
 * JSON URL (same payload):
 *   GET {data-crm}/v1/{site}/reviews
 * Public git file (after sync):
 *   crm-data/{site}/reviews.json
 */
;(function () {
  var script =
    document.currentScript ||
    document.querySelector('script[src*="reviews-embed.js"][data-site]')

  function resolveCrmBase(el) {
    if (!el) return ''
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
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // return 'https://ackvyn-crm.ackvyn.workers.dev'
    console.warn(
      '[Ackvyn CRM] reviews-embed.js missing data-crm — set data-crm to your Worker origin',
    )
    return ''
  }

  var base = resolveCrmBase(script)
  if (!base) return
  var defaultSite = script && script.getAttribute('data-site')

  function reviewsUrl(site) {
    return base + '/v1/' + encodeURIComponent(site) + '/reviews'
  }

  function get(site) {
    var key = String(site || defaultSite || '').trim()
    if (!base) {
      return Promise.reject(new Error('AckvynReviews: missing data-crm'))
    }
    if (!key) {
      return Promise.reject(new Error('AckvynReviews: missing data-site'))
    }
    return fetch(reviewsUrl(key))
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var err = new Error(
              (data && data.error) || 'reviews_fetch_failed',
            )
            err.status = res.status
            err.payload = data
            throw err
          }
          return data
        })
      })
      .then(function (data) {
        try {
          window.dispatchEvent(
            new CustomEvent('ackvyn-reviews', {
              detail: Object.assign({ site: key }, data),
            }),
          )
        } catch (e) {}
        return data
      })
  }

  window.AckvynReviews = {
    get: get,
    url: reviewsUrl,
    base: base,
  }

  if (defaultSite && script.getAttribute('data-autoload') !== 'false') {
    get(defaultSite).catch(function (err) {
      try {
        window.dispatchEvent(
          new CustomEvent('ackvyn-reviews-error', { detail: err }),
        )
      } catch (e) {}
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[AckvynReviews]', err && err.message ? err.message : err)
      }
    })
  }
})()
