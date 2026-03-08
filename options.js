document.addEventListener('DOMContentLoaded', () => {
    const zoomMode = document.getElementById('zoomMode');
    const triggerKey = document.getElementById('triggerKey');
    const zoomStyle = document.getElementById('zoomStyle');
    const panSpeed = document.getElementById('panSpeed');
    const overlayOpacity = document.getElementById('overlayOpacity');
    const panSpeedVal = document.getElementById('panSpeedVal');
    const overlayOpacityVal = document.getElementById('overlayOpacityVal');
    const enablePinch = document.getElementById('enablePinch');
    const status = document.getElementById('status');
    const historyContainer = document.getElementById('historyContainer');
    const clearHistoryBtn = document.getElementById('clearHistory');

    function showStatus() {
        status.classList.add('show');
        setTimeout(() => {
            status.classList.remove('show');
        }, 2000);
    }

    // Load saved settings
    chrome.storage.sync.get({
        zoomMode: 'hold',
        triggerKey: 'Alt',
        zoomStyle: 'fullscreen',
        panSpeed: 1.0,
        overlayOpacity: 0.7,
        enablePinch: false
    }, (items) => {
        zoomMode.value = items.zoomMode;
        triggerKey.value = items.triggerKey;
        zoomStyle.value = items.zoomStyle;
        panSpeed.value = items.panSpeed;
        overlayOpacity.value = items.overlayOpacity;
        enablePinch.checked = items.enablePinch;
        
        panSpeedVal.textContent = parseFloat(items.panSpeed).toFixed(1) + 'x';
        overlayOpacityVal.textContent = Math.round(items.overlayOpacity * 100) + '%';
    });

    // Load history
    function loadHistory() {
        chrome.storage.local.get({ imageHistory: [] }, (res) => {
            const history = res.imageHistory;
            if (history.length === 0) {
                historyContainer.innerHTML = '<p style="color: #64748b; font-size: 13px; grid-column: 1 / -1;">No history yet. Zoom some images!</p>';
                return;
            }
            
            historyContainer.innerHTML = '';
            history.forEach(item => {
                const a = document.createElement('a');
                a.href = item.src;
                a.target = '_blank';
                a.style.display = 'block';
                a.style.height = '80px';
                a.style.borderRadius = '6px';
                a.style.overflow = 'hidden';
                a.style.border = '1px solid #334155';
                a.style.backgroundImage = `url("${item.src}")`;
                a.style.backgroundSize = 'cover';
                a.style.backgroundPosition = 'center';
                a.title = new Date(item.time).toLocaleString();
                historyContainer.appendChild(a);
            });
        });
    }
    loadHistory();

    clearHistoryBtn.addEventListener('click', () => {
        chrome.storage.local.set({ imageHistory: [] }, () => {
            loadHistory();
            showStatus();
        });
    });

    // Save on change
    zoomMode.addEventListener('change', () => chrome.storage.sync.set({ zoomMode: zoomMode.value }, showStatus));
    triggerKey.addEventListener('change', () => chrome.storage.sync.set({ triggerKey: triggerKey.value }, showStatus));
    zoomStyle.addEventListener('change', () => chrome.storage.sync.set({ zoomStyle: zoomStyle.value }, showStatus));
    enablePinch.addEventListener('change', () => chrome.storage.sync.set({ enablePinch: enablePinch.checked }, showStatus));

    panSpeed.addEventListener('input', () => {
        const val = parseFloat(panSpeed.value);
        panSpeedVal.textContent = val.toFixed(1) + 'x';
        chrome.storage.sync.set({ panSpeed: val }, showStatus);
    });

    overlayOpacity.addEventListener('input', () => {
        const val = parseFloat(overlayOpacity.value);
        overlayOpacityVal.textContent = Math.round(val * 100) + '%';
        chrome.storage.sync.set({ overlayOpacity: val }, showStatus);
    });
});

