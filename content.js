(function () {
    'use strict';

    // ─── State ────────────────────────────────────────────────────────────────
    let zoomState = null;
    let resetTimeout = null;

    // ─── Smooth zoom interpolation ────────────────────────────────────────────
    let _smoothRafId = null;
    let _renderTx = 0, _renderTy = 0, _renderScale = 1;
    const LERP_SPEED = 0.25;

    // ─── Default Settings ─────────────────────────────────────────────────────
    let settings = {
        zoomMode: 'hold',
        triggerKey: 'Alt',
        zoomStyle: 'fullscreen',
        panSpeed: 1.0,
        overlayOpacity: 0.7,
        enablePinch: false, // Default to false to avoid browser zoom conflicts
        enabledDomains: {} // { "example.com": true/false }
    };

    // ─── Load & watch settings ────────────────────────────────────────────────
    if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.sync.get(settings, (items) => {
            Object.assign(settings, items);
        });
        chrome.storage.onChanged.addListener((changes) => {
            for (let key in changes) {
                settings[key] = changes[key].newValue;
            }
            if (zoomState && zoomState.overlay && changes.overlayOpacity) {
                zoomState.overlay.style.backgroundColor =
                    `rgba(0,0,0,${settings.overlayOpacity})`;
            }
        });
    }

    // ─── History Logging ──────────────────────────────────────────────────────
    function logToHistory(src) {
        if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
        chrome.storage.local.get({ imageHistory: [] }, (res) => {
            let history = res.imageHistory;
            // Remove duplicates
            history = history.filter(item => item.src !== src);
            // Add to front
            history.unshift({ src, time: Date.now() });
            // Keep last 50
            if (history.length > 50) history.pop();
            chrome.storage.local.set({ imageHistory: history });
        });
    }


    // ─── Domain opt-out and Conflict check ────────────────────────────────────
    function isConflictSite() {
        const host = location.hostname;
        // Amazon product images have their own zoom
        if (host.includes('amazon.') && document.querySelector('#imgTagWrapperId')) return true;
        // eBay product images
        if (host.includes('ebay.') && document.querySelector('.ux-image-magnify')) return true;
        // Walmart product images
        if (host.includes('walmart.') && document.querySelector('.hover-zoom-container')) return true;
        return false;
    }

    function isEnabled() {
        const host = location.hostname;
        if (settings.enabledDomains && settings.enabledDomains[host] === false) {
            return false;
        }
        if (isConflictSite()) return false;
        return true;
    }

    // ─── Security & Sanitization ─────────────────────────────────────────────
    function safeSetText(el, text) {
        if (el) el.textContent = text;
    }

    function isSafeUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url, location.href);
            return ['http:', 'https:', 'data:', 'blob:'].includes(u.protocol);
        } catch (_) {
            return false;
        }
    }

    function sanitizeSvg(svgString) {
        // Basic sanitization: remove <script> tags
        return svgString.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "");
    }

    // ─── Context menu check ───────────────────────────────────────────────────
    function isContextMenuOpen() {
        return !!document.getElementById('__zoom_toolbar__');
    }

    // ─── Upgrade thumbnail URL to full-size where possible ─────────────────
    function upgradeImageUrl(src) {
        if (!src || !isSafeUrl(src)) return src;
        try {
            const u = new URL(src, location.href);

            // Google Images: handle gstatic thumbnails
            if (u.hostname.includes('gstatic.com') && u.pathname.startsWith('/images')) {
                // These are usually thumbnails, finding the original requires DOM traversal
                // rather than just a URL transformation.
                return src;
            }

            // Twitter / X: replace &name=small/medium/thumb with &name=large
            if (u.hostname === 'pbs.twimg.com') {
                u.searchParams.set('name', 'large');
                return u.href;
            }

            // WordPress / Jetpack: strip -WxH before the extension
            const wpMatch = u.pathname.match(/^(.+)-\d+x\d+(\.[a-z]{3,4})$/i);
            if (wpMatch) {
                u.pathname = wpMatch[1] + wpMatch[2];
                return u.href;
            }

            // Shopify CDN: _100x, _200x etc.
            if (u.hostname.includes('shopify.com') || u.hostname.includes('cdn.shopify')) {
                u.pathname = u.pathname.replace(/_\d+x(\d+)?/g, '');
                return u.href;
            }

            // Medium: strip /max/WxH/ or /fit/WxH/ path segments
            if (u.hostname.includes('medium.com') || u.hostname.includes('miro.medium.com')) {
                u.pathname = u.pathname.replace(/\/(max|fit)\/\d+(\/|$)/g, '/max/4096/');
                return u.href;
            }

            // Cloudinary: replace w_N,h_N or c_thumb etc. with c_limit,w_2000
            if (u.hostname.includes('cloudinary.com') || u.hostname.includes('res.cloudinary.com')) {
                u.pathname = u.pathname.replace(/\/[a-z]_[^/]+/g, (m) => {
                    if (m.startsWith('/c_')) return '/c_limit';
                    if (m.startsWith('/w_')) return '/w_2000';
                    if (m.startsWith('/h_')) return '';
                    return m;
                });
                return u.href;
            }

            // Imgur: remove suffix letter before extension (e.g. abcds.jpg → abcd.jpg)
            if (u.hostname.includes('imgur.com') || u.hostname === 'i.imgur.com') {
                u.pathname = u.pathname.replace(/([a-zA-Z0-9]{5,})[sbtlmh](\.[a-z]{3,4})$/i, '$1$2');
                return u.href;
            }

            // Generic: strip common thumb/resize query params
            for (const p of ['w', 'width', 'h', 'height', 'resize', 'size', 'quality']) {
                u.searchParams.delete(p);
            }
            if (u.href !== src) return u.href;

        } catch (_) { }
        return src;
    }

    // ─── Target detection (IMG, SVG, background-image) ───────────────────────
    function findZoomTarget(x, y) {
        const elements = document.elementsFromPoint(x, y);

        // 0. Special handling for Google Images (2025-2026 selectors)
        if (location.hostname.includes('google.')) {
            // Priority 1: High-res preview in the side panel
            // These classes (n3VNCb, sFlh5c, i6v61d) are the standard for Google's large preview
            const previewImg = elements.find(el => 
                el.tagName === 'IMG' && 
                (el.classList.contains('n3VNCb') || el.classList.contains('sFlh5c') || el.classList.contains('i6v61d'))
            );
            
            if (previewImg && previewImg.src && !previewImg.src.startsWith('data:')) {
                return { el: previewImg, src: previewImg.src, type: 'img', isHighRes: true };
            }

            // Priority 2: Check for grid thumbnails and their high-res attributes
            const gridImg = elements.find(el => el.tagName === 'IMG' && (el.hasAttribute('data-iurl') || el.hasAttribute('data-src')));
            if (gridImg) {
                // Try to find the associated <a> tag which might contain the original source page/image link
                const parentLink = gridImg.closest('a');
                let highRes = gridImg.getAttribute('data-iurl') || gridImg.getAttribute('data-src') || gridImg.src;
                
                // If it's a data URL, it's still just a thumbnail placeholder
                const isPlaceholder = highRes.startsWith('data:');
                return { el: gridImg, src: highRes, type: 'img', isPlaceholder };
            }
        }

        // 1. Prefer native <img>
        const img = elements.find(el => el.tagName === 'IMG' && el.src);
        if (img) {
            // Also check if the img is inside an <a> linking to a larger image
            const parentLink = img.closest('a[href]');
            let fullSrc = upgradeImageUrl(img.src);
            if (parentLink) {
                const href = parentLink.href;
                if (/\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)(\?|$)/i.test(href) && isSafeUrl(href)) {
                    fullSrc = href;
                }
            }
            // Check srcset for the largest available source
            if (img.srcset) {
                const candidates = img.srcset.split(',').map(s => {
                    const parts = s.trim().split(/\s+/);
                    const w = parseInt((parts[1] || '0').replace('w', ''), 10) || 0;
                    return { url: parts[0], w };
                }).filter(c => c.url && isSafeUrl(c.url));
                if (candidates.length > 0) {
                    candidates.sort((a, b) => b.w - a.w);
                    if (candidates[0].w > (img.naturalWidth || img.width || 0)) {
                        fullSrc = candidates[0].url;
                    }
                }
            }
            return { el: img, src: fullSrc, type: 'img' };
        }

        // 2. <svg> element
        const svg = elements.find(el => el.tagName === 'SVG' || el.closest('svg'));
        if (svg) {
            const realSvg = svg.tagName === 'SVG' ? svg : svg.closest('svg');
            const svgData = sanitizeSvg(new XMLSerializer().serializeToString(realSvg));
            const blob = new Blob([svgData], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            return { el: realSvg, src: url, type: 'svg', blobUrl: url };
        }

        // 3. background-image element
        for (const el of elements) {
            const bg = window.getComputedStyle(el).backgroundImage;
            if (bg && bg !== 'none') {
                const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
                if (match && isSafeUrl(match[1])) return { el, src: upgradeImageUrl(match[1]), type: 'bg' };
            }
        }

        return null;
    }


    // ─── Gallery: collect all visible images on page ──────────────────────────
    function getAllPageImages() {
        return Array.from(document.querySelectorAll('img[src]'))
            .filter(img => {
                const rect = img.getBoundingClientRect();
                return rect.width > 30 && rect.height > 30 && img.src;
            });
    }

    function navigateGallery(direction) {
        const images = getAllPageImages();
        if (images.length === 0) return;

        let currentIndex = -1;
        if (zoomState && zoomState.original) {
            currentIndex = images.indexOf(zoomState.original);
        }

        let nextIndex;
        if (direction === 'next') {
            nextIndex = currentIndex + 1 >= images.length ? 0 : currentIndex + 1;
        } else {
            nextIndex = currentIndex - 1 < 0 ? images.length - 1 : currentIndex - 1;
        }

        const wasZoomed = !!zoomState;
        if (wasZoomed) resetZoom(false);

        const nextImg = images[nextIndex];
        nextImg.scrollIntoView({ behavior: 'smooth', block: 'center' });

        setTimeout(() => {
            const rect = nextImg.getBoundingClientRect();
            const fakeEvent = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
            const target = { el: nextImg, src: upgradeImageUrl(nextImg.src), type: 'img' };
            initiateZoom(fakeEvent, target, 1);

            // Show gallery position in HUD
            updateHUD(1);
            const hintEl = document.getElementById('__zoom_hud_hint__');
            if (hintEl) {
                hintEl.textContent = `Image ${nextIndex + 1} of ${images.length} · [ ] to navigate`;
            }
        }, wasZoomed ? 50 : 10);
    }

    // ─── Download image ───────────────────────────────────────────────────────
    async function downloadImage() {
        if (!zoomState) return;
        try {
            const response = await fetch(zoomState.src);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');

            // Extract filename from URL path
            let filename = 'image';
            try {
                const urlPath = new URL(zoomState.src, location.href).pathname;
                const name = urlPath.split('/').pop();
                if (name && name.length > 0 && name.length < 200) filename = name;
            } catch (_) { }

            // Ensure it has an extension
            if (!filename.includes('.')) {
                const ext = blob.type.split('/')[1] || 'png';
                filename += '.' + ext.replace('jpeg', 'jpg').replace('svg+xml', 'svg');
            }

            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return true;
        } catch (_) {
            // Fallback: open in new tab so user can right-click save
            window.open(zoomState.src, '_blank');
            return false;
        }
    }

    // ─── Fit to screen ────────────────────────────────────────────────────────
    function fitToScreen() {
        if (!zoomState) return;
        const { startW, startH } = zoomState;
        const padding = 40;
        const vpW = window.innerWidth - padding * 2;
        const vpH = window.innerHeight - padding * 2;

        const newScale = Math.max(1, Math.min(vpW / startW, vpH / startH));

        zoomState.scale = newScale;
        zoomState.tx = (window.innerWidth - startW * newScale) / 2;
        zoomState.ty = (window.innerHeight - startH * newScale) / 2;
        zoomState.rotation = 0;
        zoomState.flipH = false;
        zoomState.flipV = false;

        applyTransform();
        updateHUD(newScale);
    }

    // ─── Centralized transform application (smooth interpolation) ──────────
    function applyTransform() {
        if (!zoomState || !zoomState.clone) return;
        if (!_smoothRafId) {
            // Snap render state to current on first frame
            _renderTx = zoomState.tx;
            _renderTy = zoomState.ty;
            _renderScale = zoomState.scale;
        }
        if (!_smoothRafId) _smoothRafId = requestAnimationFrame(smoothTick);
    }

    function smoothTick() {
        _smoothRafId = null;
        if (!zoomState || !zoomState.clone) return;

        const { tx, ty, scale, startW, startH } = zoomState;
        _renderTx += (tx - _renderTx) * LERP_SPEED;
        _renderTy += (ty - _renderTy) * LERP_SPEED;
        _renderScale += (scale - _renderScale) * LERP_SPEED;

        const rot = zoomState.rotation || 0;
        const fh = zoomState.flipH ? -1 : 1;
        const fv = zoomState.flipV ? -1 : 1;
        const cx = startW / 2;
        const cy = startH / 2;

        zoomState.clone.style.transform =
            `translate(${_renderTx + cx * _renderScale}px, ${_renderTy + cy * _renderScale}px) ` +
            `rotate(${rot}deg) ` +
            `scale(${_renderScale * fh}, ${_renderScale * fv}) ` +
            `translate(${-cx}px, ${-cy}px)`;

        if (settings.zoomStyle === 'loupe') {
            if (zoomState.overlay) zoomState.overlay.style.opacity = '0';
            const mX = zoomState.lastMouseX || _renderTx + cx;
            const mY = zoomState.lastMouseY || _renderTy + cy;
            
            // Map viewport mouse coordinates to the clone's internal unscaled coordinate space
            const relX = (mX - _renderTx) / _renderScale;
            const relY = (mY - _renderTy) / _renderScale;
            
            // Keep the loupe visual size constant on screen
            const loupeRadiusScreen = 150; 
            const loupeRadiusInternal = loupeRadiusScreen / _renderScale;
            
            zoomState.clone.style.clipPath = `circle(${loupeRadiusInternal}px at ${relX}px ${relY}px)`;
            
            // Add a subtle drop shadow to the loupe using a filter (clip-path hides box-shadow)
            zoomState.clone.style.filter = `drop-shadow(0 10px 20px rgba(0,0,0,0.5))`;
        } else {
            if (zoomState.overlay) zoomState.overlay.style.opacity = '1';
            zoomState.clone.style.clipPath = 'none';
            zoomState.clone.style.filter = 'none';
        }

        // Keep ticking until close enough
        const dTx = Math.abs(tx - _renderTx);
        const dTy = Math.abs(ty - _renderTy);
        const dS = Math.abs(scale - _renderScale);
        if (dTx > 0.1 || dTy > 0.1 || dS > 0.0001) {
            _smoothRafId = requestAnimationFrame(smoothTick);
        } else {
            // Snap to exact final values
            _renderTx = tx;
            _renderTy = ty;
            _renderScale = scale;
        }
    }

    // ─── HUD badge ────────────────────────────────────────────────────────────
    let hudFadeTimer = null;

    function injectHUDStyles() {
        if (document.getElementById('__zoom_hud_styles__')) return;
        const style = document.createElement('style');
        style.id = '__zoom_hud_styles__';
        style.textContent = `
            @keyframes __zoom_hud_in__ {
                0%   { opacity: 0; transform: translateY(10px) scale(0.9); }
                100% { opacity: 1; transform: translateY(0px) scale(1); }
            }
            @keyframes __zoom_hud_out__ {
                0%   { opacity: 1; transform: translateY(0px) scale(1); }
                100% { opacity: 0; transform: translateY(6px) scale(0.95); }
            }
            @keyframes __zoom_hold_pulse__ {
                0%, 100% { box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 0 2px rgba(251,146,60,0.35), 0 0 14px rgba(251,146,60,0.15); }
                50%       { box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 0 3px rgba(251,146,60,0.65), 0 0 26px rgba(251,146,60,0.3); }
            }
            @keyframes __zoom_snap_lock__ {
                0%   { box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 0 4px rgba(34,197,94,0.8); }
                60%  { box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 0 2px rgba(34,197,94,0.3); }
                100% { box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 0 1px rgba(34,197,94,0.2); }
            }
            @keyframes __zoom_bar_hold__ {
                0%   { opacity: 0.4; }
                50%  { opacity: 1; }
                100% { opacity: 0.4; }
            }
            #__zoom_hud__ {
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 2147483647;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                pointer-events: none;
                animation: __zoom_hud_in__ 0.22s cubic-bezier(0.34,1.56,0.64,1) forwards;
            }
            #__zoom_hud__ .zm-card {
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                background: rgba(10,18,35,0.92);
                border-radius: 14px;
                padding: 10px 15px 9px;
                min-width: 130px;
                display: flex;
                flex-direction: column;
                gap: 5px;
            }
            #__zoom_hud__.zm-hold .zm-card {
                border: 1.5px solid rgba(251,146,60,0.4);
                animation: __zoom_hold_pulse__ 1.8s ease-in-out infinite;
            }
            #__zoom_hud__.zm-snap .zm-card {
                border: 1.5px solid rgba(34,197,94,0.35);
                animation: __zoom_snap_lock__ 0.5s ease-out forwards;
            }
            #__zoom_hud__ .zm-header {
                display: flex;
                align-items: center;
                gap: 7px;
            }
            #__zoom_hud__ .zm-icon {
                font-size: 13px;
                line-height: 1;
            }
            #__zoom_hud__ .zm-mode-label {
                font-size: 10px;
                font-weight: 700;
                letter-spacing: 0.1em;
                text-transform: uppercase;
                flex: 1;
            }
            #__zoom_hud__.zm-hold .zm-mode-label { color: #fb923c; }
            #__zoom_hud__.zm-snap .zm-mode-label { color: #22c55e; }
            #__zoom_hud__ .zm-scale {
                font-size: 20px;
                font-weight: 800;
                letter-spacing: -0.02em;
                color: #f8fafc;
                line-height: 1;
            }
            #__zoom_hud__ .zm-hint {
                font-size: 10px;
                color: #64748b;
                letter-spacing: 0.01em;
                padding-top: 2px;
                border-top: 1px solid rgba(255,255,255,0.06);
            }
            #__zoom_hud__ .zm-info {
                font-size: 10px;
                color: #94a3b8;
                letter-spacing: 0.01em;
                display: flex;
                gap: 8px;
            }
            #__zoom_hud__ .zm-info-dim {
                color: #cbd5e1;
                font-weight: 600;
            }
            #__zoom_hud__ .zm-bar {
                height: 3px;
                border-radius: 99px;
                margin-top: 1px;
                overflow: hidden;
                background: rgba(255,255,255,0.06);
            }
            #__zoom_hud__ .zm-bar-fill {
                height: 100%;
                border-radius: 99px;
                transition: width 0.12s ease-out;
            }
            #__zoom_hud__.zm-hold .zm-bar-fill {
                background: linear-gradient(90deg, #f97316, #fb923c);
                animation: __zoom_bar_hold__ 1.8s ease-in-out infinite;
            }
            @keyframes __zoom_spin__ {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            #__zoom_hud__ .zm-loading {
                font-size: 11px;
                color: #38bdf8;
                font-weight: 600;
                display: none;
                align-items: center;
                gap: 6px;
                margin-top: 2px;
            }
            #__zoom_hud__ .zm-spinner {
                width: 12px;
                height: 12px;
                border: 2px solid rgba(56,189,248,0.3);
                border-top-color: #38bdf8;
                border-radius: 50%;
                animation: __zoom_spin__ 0.8s linear infinite;
            }
            #__zoom_hud__ .zm-hq-badge {
                background: linear-gradient(135deg, #fbbf24, #f59e0b);
                color: #451a03;
                font-size: 9px;
                font-weight: 800;
                padding: 1px 4px;
                border-radius: 4px;
                margin-left: 6px;
                display: none;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                box-shadow: 0 1px 3px rgba(245, 158, 11, 0.4);
            }
            /* Theme Syncing using standard CSS media queries */
            @media (prefers-color-scheme: light) {
                #__zoom_hud__ .zm-card {
                    background: rgba(255,255,255,0.92);
                    color: #0f172a;
                    border: 1px solid rgba(0,0,0,0.1);
                    box-shadow: 0 10px 30px rgba(0,0,0,0.1);
                }
                #__zoom_hud__ .zm-scale { color: #0f172a; }
                #__zoom_hud__ .zm-hint { color: #475569; border-top-color: rgba(0,0,0,0.1); }
                #__zoom_hud__ .zm-info { color: #334155; }
                #__zoom_hud__ .zm-info-dim { color: #0f172a; }
                #__zoom_hud__ .zm-bar { background: rgba(0,0,0,0.1); }
            }
        `;
        document.head.appendChild(style);
    }

    function buildHUDElement() {
        injectHUDStyles();
        const hud = document.createElement('div');
        hud.id = '__zoom_hud__';

        const isHold = settings.zoomMode !== 'toggle';
        hud.className = isHold ? 'zm-hold' : 'zm-snap';

        const card = document.createElement('div');
        card.className = 'zm-card';

        // Header: icon + mode label + scale + HQ badge
        const header = document.createElement('div');
        header.className = 'zm-header';

        const icon = document.createElement('span');
        icon.className = 'zm-icon';
        icon.textContent = isHold ? '🔆' : '📌';

        const modeLabel = document.createElement('span');
        modeLabel.className = 'zm-mode-label';
        modeLabel.textContent = isHold ? 'Hold Mode' : 'Snap Mode';

        const hqBadge = document.createElement('span');
        hqBadge.className = 'zm-hq-badge';
        hqBadge.id = '__zoom_hud_hq__';
        hqBadge.textContent = 'HQ';

        const scaleEl = document.createElement('span');
        scaleEl.className = 'zm-scale';
        scaleEl.id = '__zoom_hud_scale__';
        scaleEl.textContent = '1.0×';

        header.appendChild(icon);
        header.appendChild(modeLabel);
        header.appendChild(hqBadge);
        header.appendChild(scaleEl);

        // Progress bar (shows zoom level visually, max 10×)
        const bar = document.createElement('div');
        bar.className = 'zm-bar';
        const barFill = document.createElement('div');
        barFill.className = 'zm-bar-fill';
        barFill.id = '__zoom_hud_bar__';
        barFill.style.width = '0%';
        bar.appendChild(barFill);

        // Hint
        const hint = document.createElement('div');
        hint.className = 'zm-hint';
        hint.id = '__zoom_hud_hint__';
        hint.textContent = isHold ? `↑ Release ${settings.triggerKey} to close` : '↑ Esc or click to close';

        // Loading indicator
        const loading = document.createElement('div');
        loading.className = 'zm-loading';
        loading.id = '__zoom_hud_loading__';
        const spinner = document.createElement('div');
        spinner.className = 'zm-spinner';
        const loadingText = document.createElement('span');
        loadingText.textContent = 'Loading High-Res...';
        loading.appendChild(spinner);
        loading.appendChild(loadingText);

        // Image info row
        const info = document.createElement('div');
        info.className = 'zm-info';
        info.id = '__zoom_hud_info__';

        card.appendChild(header);
        card.appendChild(bar);
        card.appendChild(info);
        card.appendChild(loading);
        card.appendChild(hint);
        hud.appendChild(card);

        return hud;
    }

    function updateHUD(scale) {
        if (!zoomState) return;
        if (!zoomState.hud) {
            zoomState.hud = buildHUDElement();
            document.body.appendChild(zoomState.hud);
        }

        const scaleEl = document.getElementById('__zoom_hud_scale__');
        safeSetText(scaleEl, scale.toFixed(1) + '×');

        // Update HQ Badge
        const hqBadge = document.getElementById('__zoom_hud_hq__');
        if (hqBadge) {
            if (zoomState.src !== zoomState.original.src || zoomState.original.src.includes('max/4096') || zoomState.original.src.includes('large')) {
                hqBadge.style.display = 'inline-block';
            } else {
                hqBadge.style.display = 'none';
            }
        }

        // Bar fills proportionally: 1× = 0%, 10× = 100%
        const barEl = document.getElementById('__zoom_hud_bar__');
        if (barEl) {
            const pct = Math.min(((scale - 1) / 9) * 100, 100);
            barEl.style.width = pct.toFixed(1) + '%';
        }

        // Image info
        const infoEl = document.getElementById('__zoom_hud_info__');
        if (infoEl && zoomState) {
            infoEl.innerHTML = ''; // Clear
            // Dimensions
            const nw = zoomState.original && zoomState.original.naturalWidth;
            const nh = zoomState.original && zoomState.original.naturalHeight;
            if (nw && nh) {
                const dimSpan = document.createElement('span');
                dimSpan.className = 'zm-info-dim';
                safeSetText(dimSpan, `${nw}×${nh}`);
                infoEl.appendChild(dimSpan);
            }
            
            // Rotation / flip indicators
            const meta = [];
            const rot = zoomState.rotation || 0;
            if (rot !== 0) meta.push(`↻${rot}°`);
            if (zoomState.flipH) meta.push('⇔H');
            if (zoomState.flipV) meta.push('⇕V');
            
            if (meta.length > 0) {
                const text = (nw && nh ? ' · ' : '') + meta.join(' · ');
                infoEl.appendChild(document.createTextNode(text));
            }
        }

        if (hudFadeTimer) clearTimeout(hudFadeTimer);
        // In hold mode the HUD stays visible as long as zoom is active;
        // in snap/toggle mode fade it after a brief moment.
        if (settings.zoomMode === 'toggle') {
            hudFadeTimer = setTimeout(() => {
                if (zoomState && zoomState.hud) {
                    zoomState.hud.style.animation = '__zoom_hud_out__ 0.25s ease-out forwards';
                }
            }, 2000);
        }
    }


    function removeHUD() {
        const existing = document.getElementById('__zoom_hud__');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        if (hudFadeTimer) { clearTimeout(hudFadeTimer); hudFadeTimer = null; }
    }

    // ─── Context toolbar ──────────────────────────────────────────────────────
    function showContextToolbar(x, y) {
        if (!zoomState) return;
        removeContextToolbar();

        const bar = document.createElement('div');
        bar.id = '__zoom_toolbar__';
        bar.style.cssText = `
            position: fixed;
            z-index: 2147483647;
            left: ${Math.min(x, window.innerWidth - 420)}px;
            top:  ${Math.min(y, window.innerHeight - 56)}px;
            display: flex;
            gap: 4px;
            background: rgba(15,23,42,0.92);
            border: 1px solid rgba(56,189,248,0.25);
            border-radius: 10px;
            padding: 6px 8px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            backdrop-filter: blur(8px);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            font-size: 12px;
        `;

        const btnStyle = `
            display:flex; align-items:center; gap:4px;
            color:#f8fafc; background:rgba(255,255,255,0.07);
            border:none; border-radius:6px; padding:5px 8px;
            cursor:pointer; white-space:nowrap; font-size:11px;
            transition: background 0.15s;
        `;

        function makeBtn(label, hoverBg, onClick) {
            const btn = document.createElement('button');
            btn.style.cssText = btnStyle;
            safeSetText(btn, label);
            btn.onmouseenter = () => btn.style.background = hoverBg;
            btn.onmouseleave = () => btn.style.background = 'rgba(255,255,255,0.07)';
            btn.onclick = (e) => { e.stopPropagation(); onClick(btn); };
            return btn;
        }

        const downloadBtn = makeBtn('💾 Save', 'rgba(56,189,248,0.18)', async (btn) => {
            safeSetText(btn, '⏳ Saving…');
            const ok = await downloadImage();
            safeSetText(btn, ok ? '✅ Saved!' : '🔗 Opened');
            setTimeout(() => { safeSetText(btn, '💾 Save'); }, 1500);
        });

        const openBtn = makeBtn('🔗 Open', 'rgba(56,189,248,0.18)', () => {
            window.open(zoomState.src, '_blank');
            removeContextToolbar();
        });

        const copyLinkBtn = makeBtn('📋 Link', 'rgba(56,189,248,0.18)', async (btn) => {
            try {
                await navigator.clipboard.writeText(zoomState.src);
                safeSetText(btn, '✅ Copied!');
            } catch (_) {
                safeSetText(btn, '❌ Failed');
            }
            setTimeout(() => { safeSetText(btn, '📋 Link'); }, 1500);
        });

        const searchBtn = makeBtn('🔍 Search', 'rgba(56,189,248,0.18)', () => {
            // Using the more robust 'searchbyimage' endpoint
            const url = `https://www.google.com/searchbyimage?image_url=${encodeURIComponent(zoomState.src)}&client=app`;
            window.open(url, '_blank');
            removeContextToolbar();
        });

        const copyBtn = makeBtn('🖼️ Image', 'rgba(56,189,248,0.18)', async (btn) => {
            try {
                const resp = await fetch(zoomState.src);
                const blob = await resp.blob();
                const item = new ClipboardItem({ [blob.type]: blob });
                await navigator.clipboard.write([item]);
                safeSetText(btn, '✅ Copied!');
            } catch (_) {
                safeSetText(btn, '❌ Failed');
            }
            setTimeout(() => { safeSetText(btn, '🖼️ Image'); }, 1500);
        });

        const rotateBtn = makeBtn('↻ Rotate', 'rgba(168,85,247,0.2)', () => {
            zoomState.rotation = ((zoomState.rotation || 0) + 90) % 360;
            applyTransform();
            updateHUD(zoomState.scale);
        });

        const flipHBtn = makeBtn('⇔ Flip', 'rgba(168,85,247,0.2)', () => {
            zoomState.flipH = !zoomState.flipH;
            applyTransform();
            updateHUD(zoomState.scale);
        });

        const fitBtn = makeBtn('⊞ Fit', 'rgba(34,197,94,0.18)', () => {
            fitToScreen();
            removeContextToolbar();
        });

        const closeBtn = makeBtn('✕', 'rgba(239,68,68,0.25)', () => {
            removeContextToolbar();
            resetZoom();
        });

        bar.appendChild(downloadBtn);
        bar.appendChild(openBtn);
        bar.appendChild(copyLinkBtn);
        bar.appendChild(copyBtn);
        bar.appendChild(searchBtn);
        bar.appendChild(rotateBtn);
        bar.appendChild(flipHBtn);
        bar.appendChild(fitBtn);
        bar.appendChild(closeBtn);
        document.body.appendChild(bar);

        // Auto-dismiss after 5s of no interaction
        const autoClose = setTimeout(() => removeContextToolbar(), 5000);
        bar.addEventListener('mouseenter', () => clearTimeout(autoClose));
    }


    function removeContextToolbar() {
        const bar = document.getElementById('__zoom_toolbar__');
        if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    }

    // ─── Hover glow removed — no visual indicator on hover ─────────────────
    function removeHoverGlow() {
        // Clean up any stale rings from previous versions
        const stale = document.getElementById('__zoom_ring__');
        if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    }

    // ─── Momentum / inertia state ─────────────────────────────────────────────
    let momentum = { vx: 0, vy: 0, rafId: null };

    function stopMomentum() {
        if (momentum.rafId) {
            cancelAnimationFrame(momentum.rafId);
            momentum.rafId = null;
        }
        momentum.vx = 0;
        momentum.vy = 0;
    }

    function startMomentum() {
        stopMomentum();
        const decay = 0.92;

        function tick() {
            if (!zoomState || zoomState.scale <= 1.05) { stopMomentum(); return; }
            if (Math.abs(momentum.vx) < 0.3 && Math.abs(momentum.vy) < 0.3) {
                stopMomentum();
                return;
            }
            momentum.vx *= decay;
            momentum.vy *= decay;

            zoomState.tx += momentum.vx;
            zoomState.ty += momentum.vy;
            clampPan();
            applyTransform();
            momentum.rafId = requestAnimationFrame(tick);
        }
        momentum.rafId = requestAnimationFrame(tick);
    }

    // ─── Pan boundary clamping ────────────────────────────────────────────────
    function clampPan() {
        if (!zoomState) return;
        const { tx, ty, scale, startW, startH } = zoomState;
        const rot = ((zoomState.rotation || 0) % 360 + 360) % 360;
        const isRotated = rot === 90 || rot === 270;
        const effectiveW = (isRotated ? startH : startW) * scale;
        const effectiveH = (isRotated ? startW : startH) * scale;
        const margin = 60;

        // Image center = (tx + startW*scale/2, ty + startH*scale/2)
        const centerX = tx + startW * scale / 2;
        const centerY = ty + startH * scale / 2;

        const vpW = window.innerWidth;
        const vpH = window.innerHeight;

        const minCX = margin - effectiveW / 2;
        const maxCX = vpW - margin + effectiveW / 2;
        const minCY = margin - effectiveH / 2;
        const maxCY = vpH - margin + effectiveH / 2;

        const clampedCX = Math.min(maxCX, Math.max(minCX, centerX));
        const clampedCY = Math.min(maxCY, Math.max(minCY, centerY));

        zoomState.tx = clampedCX - startW * scale / 2;
        zoomState.ty = clampedCY - startH * scale / 2;
    }

    // ─── Reset / exit zoom ────────────────────────────────────────────────────
    function resetZoom(snapBack = true) {
        if (!zoomState) return;
        removeHoverGlow();
        removeContextToolbar();
        removeHUD();
        stopMomentum();
        if (_smoothRafId) { cancelAnimationFrame(_smoothRafId); _smoothRafId = null; }

        const { clone, overlay, original, originalOpacity, startX, startY, startW, startH } = zoomState;

        if (original) original.style.opacity = originalOpacity;

        if (clone && clone.parentNode) {
            if (snapBack) {
                // Animate back to original position before removing
                clone.style.transition = 'transform 0.22s cubic-bezier(0.4,0,0.2,1), opacity 0.18s ease-out';
                const cx = startW / 2;
                const cy = startH / 2;
                clone.style.transform = `translate(${startX + cx}px, ${startY + cy}px) rotate(0deg) scale(1, 1) translate(${-cx}px, ${-cy}px)`;
                clone.style.opacity = '0';
                setTimeout(() => { if (clone.parentNode) clone.parentNode.removeChild(clone); }, 230);
            } else {
                clone.style.transition = 'opacity 0.15s ease-out';
                clone.style.opacity = '0';
                setTimeout(() => { if (clone.parentNode) clone.parentNode.removeChild(clone); }, 160);
            }
        }

        if (overlay && overlay.parentNode) {
            overlay.style.opacity = '0';
            setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 230);
        }

        // Release blob URLs created for SVGs
        if (zoomState.blobUrl) URL.revokeObjectURL(zoomState.blobUrl);

        zoomState = null;
    }

    // ─── Initiate zoom ────────────────────────────────────────────────────────
    function initiateZoom(e, target, initialScale = 1) {
        if (!isEnabled()) return;
        removeHoverGlow();

        const rect = target.el.getBoundingClientRect();

        // Overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0;
            width: 100vw; height: 100vh;
            background-color: rgba(0,0,0,${settings.overlayOpacity});
            z-index: 2147483645;
            transition: opacity 0.2s ease-out;
            opacity: 0;
            backdrop-filter: blur(4px);
        `;
        document.body.appendChild(overlay);
        setTimeout(() => { overlay.style.opacity = '1'; }, 10);

        // Clone
        const clone = document.createElement('img');
        clone.src = target.src;
        if (target.el.srcset) clone.srcset = target.el.srcset;
        if (target.el.sizes) clone.sizes = target.el.sizes;

        const computed = window.getComputedStyle(target.el);
        clone.style.objectFit = computed.objectFit || 'contain';
        clone.style.objectPosition = computed.objectPosition || 'center';
        clone.style.borderRadius = computed.borderRadius || '0';
        clone.style.cssText += `
            position: fixed; z-index: 2147483646;
            top: 0px; left: 0px;
            width: ${rect.width}px; height: ${rect.height}px;
            margin: 0; padding: 0; border: none;
            transform-origin: 0 0;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.1);
            will-change: transform, opacity;
            cursor: grab;
        `;
        document.body.appendChild(clone);

        // Compute initial offset so the cursor stays at the click point when zooming
        let tx = rect.left;
        let ty = rect.top;

        if (initialScale > 1) {
            const imgX = (e.clientX - rect.left) / 1;
            const imgY = (e.clientY - rect.top) / 1;
            tx = e.clientX - imgX * initialScale;
            ty = e.clientY - imgY * initialScale;
        }

        zoomState = {
            original: target.el,
            originalOpacity: target.el.style.opacity || '',
            clone,
            overlay,
            src: target.src,
            blobUrl: target.blobUrl || null,
            scale: initialScale,
            tx,
            ty,
            startX: rect.left,
            startY: rect.top,
            startW: rect.width,
            startH: rect.height,
            lastMouseX: e.clientX,
            lastMouseY: e.clientY,
            hud: null,
            isDragging: false,
            rotation: 0,
            flipH: false,
            flipV: false,
        };

        target.el.style.opacity = '0';
        applyTransform();

        // Always show HUD immediately
        updateHUD(initialScale);
        logToHistory(zoomState.src);

        // If it's a placeholder (like Google grid thumbnails), show loading indicator
        if (target.isPlaceholder) {
            const loadingEl = document.getElementById('__zoom_hud_loading__');
            if (loadingEl) loadingEl.style.display = 'block';

            // Start polling for the high-res image if we are on Google
            if (location.hostname.includes('google.')) {
                let attempts = 0;
                const poll = setInterval(() => {
                    attempts++;
                    // Search for the high-res version in the DOM
                    const highRes = document.querySelector('img.n3VNCb, img.sFlh5c, img.i6v61d');
                    if (highRes && highRes.src && !highRes.src.startsWith('data:')) {
                        clearInterval(poll);
                        if (zoomState) {
                            zoomState.src = highRes.src;
                            clone.src = highRes.src;
                            if (loadingEl) loadingEl.style.display = 'none';
                            updateHUD(zoomState.scale);
                            logToHistory(zoomState.src); // Re-log the upgraded URL
                        }
                    }
                    if (attempts > 50 || !zoomState) clearInterval(poll);
                }, 200);
            }
        }
    }


    // ─── Zoom amount helper ───────────────────────────────────────────────────
    function applyZoomDelta(deltaY, pivotX, pivotY) {
        if (!zoomState) return;
        if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }

        const zoomFactor = Math.exp(deltaY * -0.003);
        let newScale = zoomState.scale * zoomFactor;

        if (newScale <= 1.01) newScale = 1;
        newScale = Math.min(newScale, 50);

        if (newScale === zoomState.scale) {
            if (newScale === 1) resetZoom();
            return;
        }

        const imgX = (pivotX - zoomState.tx) / zoomState.scale;
        const imgY = (pivotY - zoomState.ty) / zoomState.scale;

        zoomState.tx = pivotX - imgX * newScale;
        zoomState.ty = pivotY - imgY * newScale;
        zoomState.scale = newScale;

        clampPan();
        applyTransform();

        updateHUD(newScale);

        if (zoomState.scale === 1) {
            const snap = zoomState;
            resetTimeout = setTimeout(() => {
                if (zoomState === snap && zoomState.scale === 1) resetZoom();
            }, 100);
        }
    }

    // ─── Input checks ─────────────────────────────────────────────────────────
    function isTriggerKeyPressed(e) {
        if (settings.triggerKey === 'Shift') return e.shiftKey;
        if (settings.triggerKey === 'Control') return e.ctrlKey || e.metaKey;
        return e.altKey;
    }

    function checkKeyRelease(e) {
        if (settings.triggerKey === 'Shift') return e.key === 'Shift' || e.keyCode === 16;
        if (settings.triggerKey === 'Control') return e.key === 'Control' || e.key === 'Meta' || e.keyCode === 17 || e.keyCode === 91;
        return e.key === 'Alt' || e.keyCode === 18;
    }

    // ─── Wheel — scroll zoom + pinch (ctrlKey = trackpad pinch) ──────────────
    //
    //  HOLD mode:  TriggerKey + scroll → zoom starts; releasing TriggerKey → zoom closes.
    //              Scrolling without TriggerKey while active → zoom closes.
    //
    //  SNAP mode:  Plain scroll (no TriggerKey needed) → zoom starts and stays locked.
    //              Scrolling continues to adjust zoom level.
    //              Click (no drag) or Esc to close.
    //
    window.addEventListener('wheel', (e) => {
        if (!isEnabled()) return;

        const isPinch = e.ctrlKey && settings.enablePinch; // Respect toggle
        const isTrigger = isTriggerKeyPressed(e);
        const isSnap = settings.zoomMode === 'toggle';

        // ── Nothing zoomed yet ────────────────────────────────────────────────
        if (!zoomState) {
            // Hold mode needs TriggerKey (or pinch) to start
            if (!isSnap && !isTrigger && !isPinch) return;

            const target = findZoomTarget(e.clientX, e.clientY);
            if (!target) return;
            e.preventDefault();
            e.stopPropagation();
            initiateZoom(e, target, 1);
        }

        // ── Already zoomed ─────────────────────────────────────────────────────
        // Hold mode: scrolling without TriggerKey/Pinch means the user released it → exit
        if (!isSnap && !isTrigger && !isPinch) {
            e.preventDefault();
            resetZoom();
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        // Pinch uses deltaY in pixel mode — scale it down
        const delta = isPinch ? e.deltaY * 3 : e.deltaY;
        applyZoomDelta(delta, e.clientX, e.clientY);

    }, { passive: false, capture: true });


    // ─── Pan on mousemove (only when scale > 1) ───────────────────────────────
    window.addEventListener('mousemove', (e) => {
        if (!zoomState) return;
        if (zoomState.scale <= 1.05) {
            zoomState.lastMouseX = e.clientX;
            zoomState.lastMouseY = e.clientY;
            return;
        }

        stopMomentum(); // stop any inertia while actively dragging

        const dx = e.clientX - zoomState.lastMouseX;
        const dy = e.clientY - zoomState.lastMouseY;

        momentum.vx = dx * settings.panSpeed;
        momentum.vy = dy * settings.panSpeed;

        zoomState.tx += dx * settings.panSpeed;
        zoomState.ty += dy * settings.panSpeed;
        clampPan();

        applyTransform();

        zoomState.lastMouseX = e.clientX;
        zoomState.lastMouseY = e.clientY;

        // Only count as a drag if the mouse moved >5px from mousedown position
        if (!zoomState.isDragging && zoomState.mouseDownX !== undefined) {
            const ddx = e.clientX - zoomState.mouseDownX;
            const ddy = e.clientY - zoomState.mouseDownY;
            if (Math.sqrt(ddx * ddx + ddy * ddy) > 5) {
                zoomState.isDragging = true;
            }
        }
    }, { passive: true });

    // On mouse-up: release grab cursor + start momentum (or close on clean click in snap mode)
    window.addEventListener('mouseup', (e) => {
        if (!zoomState) return;

        // Never close on right-click (button 2) — that's for the context toolbar
        if (e.button === 2) return;

        const wasDrag = zoomState.isDragging;
        zoomState.isDragging = false;

        // Don't close if the context toolbar is open
        const toolbar = document.getElementById('__zoom_toolbar__');
        if (toolbar) {
            if (zoomState && zoomState.clone) zoomState.clone.style.cursor = 'grab';
            return;
        }

        if (settings.zoomMode === 'toggle' && !wasDrag) {
            // Clean click in snap mode → close zoom
            e.preventDefault();
            e.stopPropagation();
            resetZoom();
            return;
        }

        if (zoomState.scale > 1.05 && wasDrag) {
            startMomentum();
        }
        if (zoomState && zoomState.clone) zoomState.clone.style.cursor = 'grab';
    }, { capture: true });

    window.addEventListener('mousedown', (e) => {
        if (!zoomState) return;
        // Ignore right-click — let contextmenu handler deal with it
        if (e.button === 2) return;
        stopMomentum();
        // Record the position at mousedown so mouseup can tell if it was
        // a clean click (no drag) or a pan gesture.
        zoomState.mouseDownX = e.clientX;
        zoomState.mouseDownY = e.clientY;
        if (zoomState.clone) zoomState.clone.style.cursor = 'grabbing';
    }, { capture: true });

    // ─── Double-click: zoom in (when not zoomed) or reset (when zoomed) ───────
    window.addEventListener('dblclick', (e) => {
        if (!isEnabled()) return;

        if (zoomState) {
            // Reset to 1× centered on click
            resetZoom(true);
            return;
        }

        const target = findZoomTarget(e.clientX, e.clientY);
        if (!target) return;

        e.preventDefault();
        e.stopPropagation();

        // Jump to 2.5× immediately
        initiateZoom(e, target, 2.5);
    }, { capture: true });

    // ─── Keyboard: +/- zoom, arrow keys pan, Escape / Alt exit ───────────────
    window.addEventListener('keydown', (e) => {
        // Exit conditions
        if (e.key === 'Escape') { resetZoom(); return; }

        if (!zoomState) return;

        // Toggle mode: Alt press = exit
        if (settings.zoomMode === 'toggle' && (e.key === 'Alt' || e.keyCode === 18)) {
            resetZoom(); e.preventDefault(); return;
        }

        const PAN_STEP = 30;
        const ZOOM_STEP = 100; // synthetic deltaY

        switch (e.key) {
            case '+':
            case '=':
                e.preventDefault();
                applyZoomDelta(-ZOOM_STEP,
                    zoomState.tx + zoomState.startW * zoomState.scale / 2,
                    zoomState.ty + zoomState.startH * zoomState.scale / 2);
                break;
            case '-':
                e.preventDefault();
                applyZoomDelta(ZOOM_STEP,
                    zoomState.tx + zoomState.startW * zoomState.scale / 2,
                    zoomState.ty + zoomState.startH * zoomState.scale / 2);
                break;
            case 'ArrowLeft':
                if (zoomState.scale > 1.05) {
                    e.preventDefault();
                    zoomState.tx += PAN_STEP; clampPan();
                    applyTransform();
                }
                break;
            case 'ArrowRight':
                if (zoomState.scale > 1.05) {
                    e.preventDefault();
                    zoomState.tx -= PAN_STEP; clampPan();
                    applyTransform();
                }
                break;
            case 'ArrowUp':
                if (zoomState.scale > 1.05) {
                    e.preventDefault();
                    zoomState.ty += PAN_STEP; clampPan();
                    applyTransform();
                }
                break;
            case 'ArrowDown':
                if (zoomState.scale > 1.05) {
                    e.preventDefault();
                    zoomState.ty -= PAN_STEP; clampPan();
                    applyTransform();
                }
                break;
            case 'r':
            case 'R':
                e.preventDefault();
                zoomState.rotation = ((zoomState.rotation || 0) + 90) % 360;
                applyTransform();
                updateHUD(zoomState.scale);
                break;
            case 'h':
            case 'H':
                e.preventDefault();
                zoomState.flipH = !zoomState.flipH;
                applyTransform();
                updateHUD(zoomState.scale);
                break;
            case 'v':
            case 'V':
                e.preventDefault();
                zoomState.flipV = !zoomState.flipV;
                applyTransform();
                updateHUD(zoomState.scale);
                break;
            case 'f':
            case 'F':
                e.preventDefault();
                fitToScreen();
                break;
            case 's':
            case 'S':
                e.preventDefault();
                downloadImage();
                break;
            case '0':
                e.preventDefault();
                zoomState.scale = 1;
                zoomState.tx = zoomState.startX;
                zoomState.ty = zoomState.startY;
                zoomState.rotation = 0;
                zoomState.flipH = false;
                zoomState.flipV = false;
                applyTransform();
                updateHUD(1);
                break;
            case '[':
                e.preventDefault();
                navigateGallery('prev');
                break;
            case ']':
                e.preventDefault();
                navigateGallery('next');
                break;
            default: break;
        }
    }, { capture: true });

    window.addEventListener('keyup', (e) => {
        if (settings.zoomMode !== 'hold') return;

        const isTriggerRelease = checkKeyRelease(e);
        const isCtrlRelease = e.key === 'Control' || e.keyCode === 17;

        if (isTriggerRelease || isCtrlRelease) {
            // Only reset if BOTH trigger and ctrl (if pinch enabled) are released
            if (!isTriggerKeyPressed(e) && !e.ctrlKey) {
                if (isContextMenuOpen()) return;
                e.preventDefault();
                e.stopPropagation();
                resetZoom();
            }
        }
    }, { capture: true });

    // ─── Prevent Alt+Click from triggering browser download ───────────────────
    window.addEventListener('click', (e) => {
        if (e.altKey && isEnabled()) {
            const target = findZoomTarget(e.clientX, e.clientY);
            if (target) {
                e.preventDefault();
                e.stopPropagation();
            }
        }
    }, { capture: true });

    // ─── Right-click: context toolbar ─────────────────────────────────────────
    window.addEventListener('contextmenu', (e) => {
        if (!zoomState) return;
        e.preventDefault();
        e.stopPropagation();
        showContextToolbar(e.clientX, e.clientY);
    }, { capture: true });

    // ─── Blur / focus lost: exit ──────────────────────────────────────────────
    window.addEventListener('blur', () => {
        if (zoomState && settings.zoomMode === 'hold') {
            resetZoom(false);
        }
    });

})();
