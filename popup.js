document.addEventListener('DOMContentLoaded', async () => {
    const modeHold = document.getElementById('modeHold');
    const modeSnap = document.getElementById('modeSnap');
    const panSpeed = document.getElementById('panSpeed');
    const overlayOpacity = document.getElementById('overlayOpacity');
    const panSpeedVal = document.getElementById('panSpeedVal');
    const overlayOpacityVal = document.getElementById('overlayOpacityVal');
    const siteEnabled = document.getElementById('siteEnabled');
    const siteDomain = document.getElementById('siteDomain');
    const siteStatus = document.getElementById('siteStatus');

    // ── Get the active tab's hostname ─────────────────────────────────────────
    let currentHost = '';
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url) {
            currentHost = new URL(tab.url).hostname;
        }
    } catch (_) { }

    siteDomain.textContent = currentHost || '(no active site)';
    siteDomain.title = currentHost;

    // ── Mode card helpers ──────────────────────────────────────────────────────
    function setActiveMode(mode) {
        modeHold.classList.remove('active-hold', 'active-snap');
        modeSnap.classList.remove('active-hold', 'active-snap');
        if (mode === 'hold') {
            modeHold.classList.add('active-hold');
        } else {
            modeSnap.classList.add('active-snap');
        }
    }

    // ── Load saved settings ────────────────────────────────────────────────────
    chrome.storage.sync.get({
        zoomMode: 'hold',
        panSpeed: 1.0,
        overlayOpacity: 0.7,
        enabledDomains: {}
    }, (items) => {
        setActiveMode(items.zoomMode);
        panSpeed.value = items.panSpeed;
        overlayOpacity.value = items.overlayOpacity;

        panSpeedVal.textContent = parseFloat(items.panSpeed).toFixed(1) + '×';
        overlayOpacityVal.textContent = Math.round(items.overlayOpacity * 100) + '%';

        // Domain toggle
        const isOn = items.enabledDomains[currentHost] !== false;
        siteEnabled.checked = isOn;
        updateSiteStatus(isOn);
    });

    // ── Helpers ─────────────────────────────────────────────────────────────
    function updateSiteStatus(on) {
        siteStatus.textContent = on ? 'Enabled on this site' : 'Disabled on this site';
        siteStatus.className = 'site-status ' + (on ? 'on' : 'off');
    }

    // ── Persist on change ──────────────────────────────────────────────────────
    [modeHold, modeSnap].forEach(card => {
        card.addEventListener('click', () => {
            const mode = card.dataset.mode;
            setActiveMode(mode);
            chrome.storage.sync.set({ zoomMode: mode });
        });
    });

    panSpeed.addEventListener('input', () => {
        const val = parseFloat(panSpeed.value);
        panSpeedVal.textContent = val.toFixed(1) + '×';
        chrome.storage.sync.set({ panSpeed: val });
    });

    overlayOpacity.addEventListener('input', () => {
        const val = parseFloat(overlayOpacity.value);
        overlayOpacityVal.textContent = Math.round(val * 100) + '%';
        chrome.storage.sync.set({ overlayOpacity: val });
    });

    siteEnabled.addEventListener('change', () => {
        const on = siteEnabled.checked;
        updateSiteStatus(on);

        chrome.storage.sync.get({ enabledDomains: {} }, (items) => {
            const domains = items.enabledDomains || {};
            if (on) {
                delete domains[currentHost]; // default is enabled, so remove the override
            } else {
                domains[currentHost] = false;
            }
            chrome.storage.sync.set({ enabledDomains: domains });
        });
    });
});

