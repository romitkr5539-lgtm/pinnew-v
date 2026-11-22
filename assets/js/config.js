/**
 * Pinviddl runtime API configuration.
 * Empty apiBaseUrl uses same-origin /api/* routes (recommended when
 * Cloudflare Worker is attached to your domain under /api/*).
 * During Cloudflare Pages builds, scripts/build-pages.mjs injects
 * PINVIDDL_API_BASE_URL from environment variables.
 */
window.PINVIDDL_CONFIG = Object.freeze({
  apiBaseUrl: '',
  resolvePath: '/api/resolve',
  downloadPath: '/api/download',
  healthPath: '/api/health'
});
