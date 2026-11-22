/**
 * Pinviddl — Vanilla JavaScript Frontend Controller
 * Handles URL validation, clipboard paste, Cloudflare Worker API resolution,
 * safe DOM rendering (no innerHTML injection), real streaming downloads,
 * mobile navigation, and contact form validation.
 */

(function () {
  'use strict';

  const CONFIG = window.PINVIDDL_CONFIG || {
    apiBaseUrl: '',
    resolvePath: '/api/resolve',
    downloadPath: '/api/download',
    healthPath: '/api/health',
  };

  function getApiUrl(path) {
    const base = (CONFIG.apiBaseUrl || '').replace(/\/+$/, '');
    return `${base}${path}`;
  }

  const PINTEREST_HOST_REGEX =
    /^(?:(?:www|m|[a-z]{2})\.)?pinterest\.(?:com|co\.uk|ca|com\.au|de|fr|es|it|jp|kr|pt|at|ch|cl|com\.mx|dk|ie|nl|nz|ph|ru|se|be|co\.kr|com\.br|com\.co|com\.ec|com\.pe|com\.py|com\.uy|com\.vn|co\.nz|co\.za|fi|hu|id|in|info|mx|no|pl|ro|th|tw)$/i;

  /**
   * Client-side Pinterest URL validator (mirrors Worker rules for immediate feedback).
   */
  function validateClientPinterestUrl(rawValue) {
    let trimmed = String(rawValue || '').trim();
    if (!trimmed) {
      return { valid: false, message: 'Please paste a Pinterest Pin URL first.' };
    }

    const embedded = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
    if (embedded) {
      trimmed = embedded[0];
    } else if (/^(?:www\.)?(?:pinterest\.[a-z.]+|pin\.it)\//i.test(trimmed)) {
      trimmed = `https://${trimmed}`;
    }

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return {
        valid: false,
        message: 'Enter a valid Pinterest link such as https://www.pinterest.com/pin/... or https://pin.it/...',
      };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { valid: false, message: 'Only standard HTTP or HTTPS Pinterest links are supported.' };
    }

    const host = parsed.hostname.toLowerCase();
    if (host === 'pin.it') {
      const cleanPath = parsed.pathname.replace(/\/+$/, '');
      if (!/^\/[A-Za-z0-9_-]{3,24}$/.test(cleanPath)) {
        return {
          valid: false,
          message: 'This pin.it short link looks incomplete. Copy the full link from Pinterest.',
        };
      }
      return { valid: true, url: `https://pin.it${cleanPath}` };
    }

    if (!PINTEREST_HOST_REGEX.test(host)) {
      return {
        valid: false,
        message: 'Only Pinterest URLs (pinterest.com/pin/... or pin.it/...) are supported.',
      };
    }

    const hasPin =
      /\/pin\/\d{5,25}(?:\/|$)/i.test(parsed.pathname) ||
      /\/pin\/[^/]*?--\d{5,25}(?:\/|$)/i.test(parsed.pathname);

    if (!hasPin) {
      return {
        valid: false,
        message: 'Please paste a direct Pin URL (e.g. pinterest.com/pin/123456789/). Boards and profiles are not supported.',
      };
    }

    return { valid: true, url: trimmed };
  }

  /**
   * Builds a clean filename base from Pin title and media index.
   */
  function buildFilenameBase(title, pinId, index, total) {
    const cleaned = String(title || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9\s_-]/g, ' ')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60);

    const base = cleaned || (pinId ? `pin-${pinId}` : 'pinterest-media');
    return total > 1 ? `pinviddl-${base}-${index + 1}` : `pinviddl-${base}`;
  }

  /**
   * Builds the Worker streaming download endpoint URL.
   */
  function buildDownloadEndpointUrl(mediaUrl, filenameBase, format) {
    const params = new URLSearchParams({
      url: mediaUrl,
      filename: `${filenameBase}.${format || 'mp4'}`,
    });
    return `${getApiUrl(CONFIG.downloadPath)}?${params.toString()}`;
  }

  /**
   * Verifies that a URL uses https: before attaching to DOM elements.
   */
  function isSafeHttpsUrl(urlStr) {
    try {
      const parsed = new URL(urlStr);
      return parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Initiates a genuine browser file download through the Worker streaming endpoint.
   * Uses a real anchor download navigation so large files stream directly to disk
   * without buffering into JavaScript memory, while reporting honest status.
   */
  async function triggerRealDownload(item, filenameBase, feedbackEl, buttonEl) {
    if (!isSafeHttpsUrl(item.url)) {
      if (feedbackEl) {
        feedbackEl.textContent = 'Invalid media link.';
        feedbackEl.classList.add('is-error');
      }
      return;
    }

    const downloadHref = buildDownloadEndpointUrl(item.url, filenameBase, item.format);
    const originalLabel = buttonEl.textContent;
    buttonEl.disabled = true;
    buttonEl.textContent = 'Preparing...';

    if (feedbackEl) {
      feedbackEl.classList.remove('is-error');
      feedbackEl.textContent = 'Verifying media stream...';
    }

    try {
      // Preflight a small 1-byte range request to confirm the streaming endpoint succeeds
      // before triggering the browser download (prevents navigating to a JSON error page).
      const probe = await fetch(downloadHref, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
      });

      if (!probe.ok && probe.status !== 206) {
        let errorMsg = 'Download could not be started for this file.';
        try {
          const errJson = await probe.json();
          if (errJson && errJson.error) errorMsg = errJson.error;
        } catch {
          // ignore non-json error
        }
        throw new Error(errorMsg);
      }

      // Cancel probe body immediately
      try {
        await probe.body?.cancel();
      } catch {
        // ignore
      }

      // Trigger real browser streaming download via Content-Disposition: attachment
      const link = document.createElement('a');
      link.href = downloadHref;
      link.download = `${filenameBase}.${item.format || 'mp4'}`;
      link.rel = 'noopener noreferrer';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      if (feedbackEl) {
        feedbackEl.classList.remove('is-error');
        feedbackEl.textContent = 'Download initiated by your browser. Check your browser downloads list.';
      }
    } catch (err) {
      if (feedbackEl) {
        feedbackEl.classList.add('is-error');
        feedbackEl.textContent =
          err && err.message
            ? `${err.message} You can also try "Open Source" to save directly.`
            : 'Unable to start download. Try "Open Source" to save directly.';
      }
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = originalLabel;
    }
  }

  /**
   * Formats readable media type label.
   */
  function formatTypeLabel(type) {
    if (type === 'video') return 'Video';
    if (type === 'gif') return 'GIF';
    return 'Image';
  }

  /**
   * Initializes mobile navigation drawer.
   */
  function initMobileNav() {
    const toggleBtn = document.getElementById('mobile-menu-toggle');
    const drawer = document.getElementById('mobile-drawer');
    if (!toggleBtn || !drawer) return;

    function closeMenu() {
      drawer.classList.remove('is-open');
      toggleBtn.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }

    function openMenu() {
      drawer.classList.add('is-open');
      toggleBtn.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
    }

    toggleBtn.addEventListener('click', function () {
      const isOpen = drawer.classList.contains('is-open');
      if (isOpen) closeMenu();
      else openMenu();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && drawer.classList.contains('is-open')) {
        closeMenu();
        toggleBtn.focus();
      }
    });

    drawer.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', closeMenu);
    });
  }

  /**
   * Initializes the core Pinterest Downloader widget present on homepage and tool pages.
   */
  function initDownloader() {
    const form = document.getElementById('downloader-form');
    const input = document.getElementById('pin-url-input');
    const pasteBtn = document.getElementById('paste-btn');
    const clearBtn = document.getElementById('clear-btn');
    const submitBtn = document.getElementById('download-submit-btn');
    const resultSection = document.getElementById('result-section');

    if (!form || !input || !submitBtn || !resultSection) return;

    let activeController = null;

    function syncClearButton() {
      if (!clearBtn) return;
      clearBtn.hidden = input.value.trim().length === 0;
    }

    function clearResults() {
      resultSection.replaceChildren();
      resultSection.hidden = true;
    }

    function renderLoading(message) {
      resultSection.replaceChildren();
      const panel = document.createElement('div');
      panel.className = 'loading-panel';
      panel.setAttribute('role', 'status');

      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');

      const text = document.createElement('span');
      text.textContent = message || 'Resolving Pinterest link...';

      panel.appendChild(spinner);
      panel.appendChild(text);
      resultSection.appendChild(panel);
      resultSection.hidden = false;
    }

    function renderError(title, message) {
      resultSection.replaceChildren();
      const panel = document.createElement('div');
      panel.className = 'error-panel';
      panel.setAttribute('role', 'alert');

      const iconWrap = document.createElement('span');
      iconWrap.className = 'error-icon';
      iconWrap.setAttribute('aria-hidden', 'true');
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('width', '20');
      svg.setAttribute('height', '20');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '12');
      circle.setAttribute('r', '10');
      const line1 = document.createElementNS(svgNS, 'line');
      line1.setAttribute('x1', '12');
      line1.setAttribute('y1', '8');
      line1.setAttribute('x2', '12');
      line1.setAttribute('y2', '12');
      const line2 = document.createElementNS(svgNS, 'line');
      line2.setAttribute('x1', '12');
      line2.setAttribute('y1', '16');
      line2.setAttribute('x2', '12.01');
      line2.setAttribute('y2', '16');
      svg.appendChild(circle);
      svg.appendChild(line1);
      svg.appendChild(line2);
      iconWrap.appendChild(svg);

      const copy = document.createElement('div');
      const heading = document.createElement('h2');
      heading.className = 'error-title';
      heading.textContent = title || 'Unable to extract media';

      const desc = document.createElement('p');
      desc.className = 'error-message';
      desc.textContent = message || 'Please verify that the Pinterest Pin is public and try again.';

      copy.appendChild(heading);
      copy.appendChild(desc);
      panel.appendChild(iconWrap);
      panel.appendChild(copy);

      resultSection.appendChild(panel);
      resultSection.hidden = false;
    }

    function createPreviewElement(primaryItem, thumbnailUrl, title) {
      const stage = document.createElement('div');
      stage.className = 'media-preview-stage';

      if (primaryItem.type === 'video' && isSafeHttpsUrl(primaryItem.url)) {
        const video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.src = primaryItem.url;
        if (thumbnailUrl && isSafeHttpsUrl(thumbnailUrl)) {
          video.poster = thumbnailUrl;
        }
        video.addEventListener('error', function () {
          stage.replaceChildren();
          const fallback = document.createElement('div');
          fallback.className = 'preview-fallback';
          fallback.textContent =
            'Inline video preview unavailable in this browser. Use the Download button to save the MP4 file.';
          stage.appendChild(fallback);
        });
        stage.appendChild(video);
        return stage;
      }

      const previewSrc = isSafeHttpsUrl(primaryItem.url) ? primaryItem.url : thumbnailUrl;
      if (previewSrc && isSafeHttpsUrl(previewSrc)) {
        const img = document.createElement('img');
        img.src = previewSrc;
        img.alt = title || 'Pinterest Pin media preview';
        img.loading = 'eager';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', function () {
          stage.replaceChildren();
          const fallback = document.createElement('div');
          fallback.className = 'preview-fallback';
          fallback.textContent =
            'Preview image could not be rendered directly. Use the Download button to save the original file.';
          stage.appendChild(fallback);
        });
        stage.appendChild(img);
        return stage;
      }

      const empty = document.createElement('div');
      empty.className = 'preview-fallback';
      empty.textContent = 'Preview unavailable';
      stage.appendChild(empty);
      return stage;
    }

    function renderResult(data) {
      resultSection.replaceChildren();

      const mediaItems = Array.isArray(data.media) ? data.media : [];
      if (mediaItems.length === 0) {
        renderError('No downloadable media found', 'This Pin did not return any publicly downloadable media files.');
        return;
      }

      const primaryItem = mediaItems[0];
      const card = document.createElement('article');
      card.className = 'result-card';
      card.setAttribute('aria-label', 'Downloadable Pinterest media');

      const mainGrid = document.createElement('div');
      mainGrid.className = 'result-main-grid';

      // Left: Media preview
      const previewEl = createPreviewElement(primaryItem, data.thumbnail, data.title);
      mainGrid.appendChild(previewEl);

      // Right: Metadata & Download controls
      const details = document.createElement('div');
      details.className = 'result-details';

      // Clean unboxed typographic metadata separated by middle dots
      const metaLine = document.createElement('div');
      metaLine.className = 'result-meta-line';

      const typeSpan = document.createElement('span');
      typeSpan.className = 'result-meta-type';
      typeSpan.textContent = formatTypeLabel(data.type || primaryItem.type);
      metaLine.appendChild(typeSpan);

      const metaParts = [];
      if (primaryItem.quality) metaParts.push(primaryItem.quality);
      if (primaryItem.format) metaParts.push(primaryItem.format.toUpperCase());
      if (primaryItem.width && primaryItem.height && !String(primaryItem.quality || '').includes('×')) {
        metaParts.push(`${primaryItem.width} × ${primaryItem.height}`);
      }
      if (primaryItem.durationSec) {
        metaParts.push(`${primaryItem.durationSec}s`);
      }
      if (mediaItems.length > 1) {
        metaParts.push(`${mediaItems.length} files available`);
      }

      metaParts.forEach(function (part) {
        const dot = document.createElement('span');
        dot.className = 'meta-dot';
        dot.setAttribute('aria-hidden', 'true');
        dot.textContent = '·';
        const val = document.createElement('span');
        val.textContent = part;
        metaLine.appendChild(dot);
        metaLine.appendChild(val);
      });

      details.appendChild(metaLine);

      const titleEl = document.createElement('h2');
      titleEl.className = 'result-title';
      titleEl.textContent = data.title || 'Pinterest Media';
      details.appendChild(titleEl);

      if (data.author) {
        const authorEl = document.createElement('p');
        authorEl.className = 'result-author';
        authorEl.textContent = `Shared by ${data.author}`;
        details.appendChild(authorEl);
      }

      const feedbackEl = document.createElement('p');
      feedbackEl.className = 'download-feedback';
      feedbackEl.setAttribute('aria-live', 'polite');

      // Primary download options (show up to 4 top options directly in the primary panel)
      const optionsList = document.createElement('div');
      optionsList.className = 'download-options-list';

      const primaryOptions =
        data.type === 'video'
          ? mediaItems.slice(0, 4)
          : mediaItems.length === 1
            ? [primaryItem]
            : [primaryItem];

      primaryOptions.forEach(function (item, idx) {
        const row = document.createElement('div');
        row.className = 'download-row';

        const info = document.createElement('div');
        info.className = 'download-row-info';

        const label = document.createElement('span');
        label.className = 'download-row-label';
        const itemTypeLabel = formatTypeLabel(item.type);
        label.textContent =
          item.type === 'image' && data.type === 'video'
            ? 'Cover Image'
            : `${itemTypeLabel} — ${item.quality || 'Original'}`;

        const specs = document.createElement('span');
        specs.className = 'download-row-specs';
        const specParts = [String(item.format || 'file').toUpperCase()];
        if (item.width && item.height) specParts.push(`${item.width}x${item.height}`);
        specs.textContent = specParts.join(' · ');

        info.appendChild(label);
        info.appendChild(specs);

        const actions = document.createElement('div');
        actions.className = 'download-row-actions';

        const filenameBase = buildFilenameBase(data.title, data.pinId, idx, mediaItems.length);

        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = idx === 0 ? 'btn-download' : 'btn-download btn-download--secondary';
        dlBtn.textContent = `Download ${(item.format || 'File').toUpperCase()}`;
        dlBtn.addEventListener('click', function () {
          triggerRealDownload(item, filenameBase, feedbackEl, dlBtn);
        });

        actions.appendChild(dlBtn);

        if (isSafeHttpsUrl(item.url)) {
          const openLink = document.createElement('a');
          openLink.className = 'btn-direct-link';
          openLink.href = item.url;
          openLink.target = '_blank';
          openLink.rel = 'noopener noreferrer nofollow';
          openLink.textContent = 'Open Source';
          actions.appendChild(openLink);
        }

        row.appendChild(info);
        row.appendChild(actions);
        optionsList.appendChild(row);
      });

      details.appendChild(optionsList);
      details.appendChild(feedbackEl);

      mainGrid.appendChild(details);
      card.appendChild(mainGrid);

      // Multi-item gallery when the Pin genuinely exposes multiple distinct images/slides
      const galleryItems =
        data.type === 'video'
          ? mediaItems.slice(primaryOptions.length)
          : mediaItems.length > 1
            ? mediaItems
            : [];

      if (galleryItems.length > 0) {
        const multiSection = document.createElement('div');
        multiSection.className = 'multi-media-section';

        const heading = document.createElement('h3');
        heading.className = 'multi-media-heading';
        heading.textContent = `All Available Media Files (${galleryItems.length})`;
        multiSection.appendChild(heading);

        const grid = document.createElement('div');
        grid.className = 'multi-media-grid';

        galleryItems.forEach(function (item, idx) {
          const tile = document.createElement('div');
          tile.className = 'multi-media-item';

          const thumb = document.createElement('div');
          thumb.className = 'multi-media-thumb';

          if (item.type === 'video' && isSafeHttpsUrl(item.url)) {
            const vid = document.createElement('video');
            vid.src = item.url;
            vid.muted = true;
            vid.preload = 'metadata';
            if (item.thumbnail && isSafeHttpsUrl(item.thumbnail)) {
              vid.poster = item.thumbnail;
            }
            thumb.appendChild(vid);
          } else if (isSafeHttpsUrl(item.url)) {
            const img = document.createElement('img');
            img.src = item.url;
            img.alt = `${data.title || 'Pinterest media'} — item ${idx + 1}`;
            img.loading = 'lazy';
            img.referrerPolicy = 'no-referrer';
            thumb.appendChild(img);
          }

          const body = document.createElement('div');
          body.className = 'multi-media-body';

          const meta = document.createElement('div');
          meta.className = 'multi-media-meta';
          const parts = [formatTypeLabel(item.type), String(item.format || '').toUpperCase()];
          if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
          meta.textContent = parts.filter(Boolean).join(' · ');

          const itemBtn = document.createElement('button');
          itemBtn.type = 'button';
          itemBtn.className = 'btn-download';
          itemBtn.textContent = `Download Item ${idx + 1}`;
          const fname = buildFilenameBase(data.title, data.pinId, idx, galleryItems.length);
          itemBtn.addEventListener('click', function () {
            triggerRealDownload(item, fname, feedbackEl, itemBtn);
          });

          body.appendChild(meta);
          body.appendChild(itemBtn);

          tile.appendChild(thumb);
          tile.appendChild(body);
          grid.appendChild(tile);
        });

        multiSection.appendChild(grid);
        card.appendChild(multiSection);
      }

      resultSection.appendChild(card);
      resultSection.hidden = false;
    }

    // Input sync
    input.addEventListener('input', syncClearButton);
    syncClearButton();

    // Paste button
    if (pasteBtn) {
      pasteBtn.addEventListener('click', async function () {
        if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
          input.focus();
          renderError(
            'Clipboard access unavailable',
            'Your browser does not allow automatic clipboard reading here. Click the input field and press Ctrl+V (or Cmd+V) to paste.'
          );
          return;
        }
        try {
          const clipText = await navigator.clipboard.readText();
          if (clipText && clipText.trim()) {
            input.value = clipText.trim();
            syncClearButton();
            input.focus();
          } else {
            input.focus();
          }
        } catch {
          input.focus();
          renderError(
            'Clipboard permission needed',
            'Paste permission was declined by your browser. Click the input box and press Ctrl+V (or Cmd+V) to paste your Pinterest URL.'
          );
        }
      });
    }

    // Clear button
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        if (activeController) {
          activeController.abort();
          activeController = null;
        }
        input.value = '';
        syncClearButton();
        clearResults();
        submitBtn.disabled = false;
        submitBtn.textContent = 'Download';
        input.focus();
      });
    }

    // Form submit -> POST /api/resolve
    form.addEventListener('submit', async function (event) {
      event.preventDefault();

      const validation = validateClientPinterestUrl(input.value);
      if (!validation.valid) {
        renderError('Invalid Pinterest URL', validation.message);
        input.focus();
        return;
      }

      if (activeController) {
        activeController.abort();
      }
      activeController = new AbortController();
      const timeoutId = window.setTimeout(function () {
        if (activeController) activeController.abort();
      }, 15000);

      submitBtn.disabled = true;
      submitBtn.textContent = 'Resolving...';
      renderLoading('Fetching public Pin metadata from Pinterest...');

      try {
        const response = await fetch(getApiUrl(CONFIG.resolvePath), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ url: validation.url }),
          signal: activeController.signal,
        });

        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }

        if (!response.ok || !payload || !payload.success) {
          const msg =
            (payload && payload.error) ||
            (response.status === 429
              ? 'Too many requests in a short time. Please wait a minute and try again.'
              : 'This Pinterest Pin could not be resolved. Please make sure the Pin is public.');
          renderError('Could not resolve Pin', msg);
          return;
        }

        renderResult(payload);
      } catch (err) {
        if (err && err.name === 'AbortError') {
          renderError(
            'Request timed out',
            'Pinterest took too long to respond. Please check the URL and try again.'
          );
        } else {
          renderError(
            'Network error',
            'Unable to reach the Pinviddl API right now. Please check your connection and try again.'
          );
        }
      } finally {
        window.clearTimeout(timeoutId);
        activeController = null;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Download';
      }
    });
  }

  /**
   * Initializes Contact page form validation & honest mailto handoff.
   */
  function initContactForm() {
    const form = document.getElementById('contact-form');
    const statusBox = document.getElementById('contact-form-status');
    if (!form || !statusBox) return;

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      const name = String(form.elements.name?.value || '').trim();
      const email = String(form.elements.email?.value || '').trim();
      const topic = String(form.elements.topic?.value || 'General Inquiry').trim();
      const message = String(form.elements.message?.value || '').trim();

      if (name.length < 2) {
        statusBox.hidden = false;
        statusBox.className = 'form-status is-error';
        statusBox.textContent = 'Please enter your name (at least 2 characters).';
        return;
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        statusBox.hidden = false;
        statusBox.className = 'form-status is-error';
        statusBox.textContent = 'Please enter a valid email address.';
        return;
      }

      if (message.length < 15) {
        statusBox.hidden = false;
        statusBox.className = 'form-status is-error';
        statusBox.textContent = 'Please provide a clear message (at least 15 characters).';
        return;
      }

      const subject = encodeURIComponent(`[Pinviddl] ${topic} — from ${name}`);
      const body = encodeURIComponent(`Name: ${name}\nReply Email: ${email}\nTopic: ${topic}\n\n${message}`);
      const mailtoHref = `mailto:support@pinviddl.com?subject=${subject}&body=${body}`;

      statusBox.hidden = false;
      statusBox.className = 'form-status';
      statusBox.replaceChildren();

      const textNode = document.createTextNode(
        'Your inquiry is formatted and ready. Pinviddl does not store form submissions on a database — click below to send it directly via your email client: '
      );
      const link = document.createElement('a');
      link.href = mailtoHref;
      link.textContent = 'Open Email Draft to support@pinviddl.com';
      link.style.color = '#e60023';
      link.style.fontWeight = '600';
      link.style.textDecoration = 'underline';

      statusBox.appendChild(textNode);
      statusBox.appendChild(link);
    });
  }

  /**
   * Initializes smooth jump to downloader input when clicking header CTA on tool pages.
   */
  function initHeaderCtaFocus() {
    const cta = document.querySelector('.header-cta[href="#downloader"]');
    const input = document.getElementById('pin-url-input');
    if (!cta || !input) return;

    cta.addEventListener('click', function (event) {
      event.preventDefault();
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(function () {
        input.focus();
      }, 220);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initMobileNav();
    initDownloader();
    initContactForm();
    initHeaderCtaFocus();
  });
})();
