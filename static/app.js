// app.js - Lógica principal para Lector de Textos IA
// Modularizado y documentado

// --- Referencias a elementos del DOM ---
const form = document.getElementById('textForm');
const textInput = document.getElementById('textInput');
const highlightOverlay = document.getElementById('highlightOverlay');
const audioContainer = document.getElementById('audioContainer');
const statusBar = document.getElementById('statusBar');
const cancelBtn = document.getElementById('cancelBtn');
const exportBtn = document.getElementById('exportBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const pdfInput = document.getElementById('pdfInput');
const pdfStatus = document.getElementById('pdfStatus');

// --- Estado global ---
let cancelRequested = false;
let isPaused = false;
let audioElem = null;
let current = 0;
let audios = [];
let textParts = [];

// --- Utilidades de UI ---
function showError(msg) {
    const alert = document.createElement('div');
    alert.className = 'alert alert-danger alert-dismissible fade show position-fixed';
    alert.role = 'alert';
    alert.style = 'bottom: 20px; right: 20px; max-width: 400px; z-index: 9999;';
    alert.innerHTML = msg + '<button type="button" class="btn-close" data-bs-dismiss="alert"></button>';
    document.body.appendChild(alert);
    setTimeout(() => alert.remove(), 6000);
}
function updateStatus(message) {
    statusBar.textContent = message;
}

// --- Procesamiento de texto ---
function getPartsFromText(text) {
    let raw = text.split(/(?:\r?\n){2,}/g);
    let parts = [];
    for (let p of raw) {
        let trimmed = p.trim();
        if (!trimmed) continue;
        if (trimmed.length > 500) {
            let sentences = trimmed.match(/[^.!?\n]+[.!?\n]+/g) || [trimmed];
            let buffer = '';
            for (let s of sentences) {
                if ((buffer + s).length > 500) {
                    parts.push(buffer.trim());
                    buffer = '';
                }
                buffer += s;
            }
            if (buffer.trim()) parts.push(buffer.trim());
        } else {
            parts.push(trimmed);
        }
    }
    return parts;
}

// --- Resaltado de texto ---
function highlightParagraph(paragraphIndex) {
    if (!textParts.length || paragraphIndex >= textParts.length) return;
    const fullText = textInput.value;
    const partToHighlight = textParts[paragraphIndex];
    const startPos = fullText.indexOf(partToHighlight);
    if (startPos === -1) return;
    const beforeText = fullText.substring(0, startPos);
    const highlightedPart = partToHighlight;
    const afterText = fullText.substring(startPos + highlightedPart.length);
    highlightOverlay.innerHTML = '';
    if (beforeText) {
        const beforeSpan = document.createElement('span');
        beforeSpan.textContent = beforeText;
        highlightOverlay.appendChild(beforeSpan);
    }
    const highlightSpan = document.createElement('span');
    highlightSpan.className = 'highlight';
    highlightSpan.textContent = highlightedPart;
    highlightOverlay.appendChild(highlightSpan);
    if (afterText) {
        const afterSpan = document.createElement('span');
        afterSpan.textContent = afterText;
        highlightOverlay.appendChild(afterSpan);
    }
    // Scroll automático
    const textAreaHeight = textInput.clientHeight;
    const lineHeight = parseInt(window.getComputedStyle(textInput).lineHeight);
    const linesInView = Math.floor(textAreaHeight / lineHeight);
    const beforeLines = beforeText.split('\n').length;
    const highlightedLines = highlightedPart.split('\n').length;
    const currentScrollPos = textInput.scrollTop / lineHeight;
    if (beforeLines < currentScrollPos || beforeLines + highlightedLines > currentScrollPos + linesInView) {
        textInput.scrollTop = lineHeight * (beforeLines - 2);
    }
    updateStatus(`Reproduciendo parte ${paragraphIndex + 1} de ${textParts.length}`);
}
function clearHighlight() {
    highlightOverlay.innerHTML = '';
}
function jumpToPart(idx) {
    if (idx >= 0 && idx < textParts.length && audios.length && idx < audios.length) {
        current = idx;
        if (audioElem) audioElem.pause();
        playNext();
    }
}

// --- Sincronización de scroll ---
textInput.addEventListener('scroll', () => {
    highlightOverlay.scrollTop = textInput.scrollTop;
});

// --- Botones de control ---
cancelBtn.onclick = async () => {
    cancelRequested = true;
    clearHighlight();
    audioContainer.innerHTML = '';
    if (audioElem) audioElem.pause();
    updateStatus('Lectura cancelada');
    textInput.readOnly = false;
    await fetch('/clear_cache', { method: 'POST' });
};
exportBtn.onclick = async () => {
    exportBtn.disabled = true;
    const originalText = exportBtn.innerHTML;
    exportBtn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Exportando...`;
    updateStatus('Exportando audio...');
    const res = await fetch('/export_all', { method: 'POST' });
    const data = await res.json();
    exportBtn.disabled = false;
    exportBtn.innerHTML = originalText;
    if (data.export_url) {
        const a = document.createElement('a');
        a.href = data.export_url;
        a.download = 'lectura_completa.mp3';
        a.click();
        updateStatus('Audio exportado con éxito');
    } else {
        updateStatus('Error al exportar el audio');
        showError('No se pudo exportar el audio.');
    }
};
pauseBtn.onclick = () => {
    if (audioElem && !audioElem.paused) {
        audioElem.pause();
        isPaused = true;
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = '';
        updateStatus('Reproducción pausada');
    }
};
resumeBtn.onclick = () => {
    if (audioElem && isPaused) {
        audioElem.play();
        isPaused = false;
        pauseBtn.style.display = '';
        resumeBtn.style.display = 'none';
        updateStatus(`Reproduciendo parte ${current + 1} de ${textParts.length}`);
    }
};
prevBtn.onclick = () => {
    if (current > 0) {
        current--;
        if (audioElem) audioElem.pause();
        playNext();
    }
};
nextBtn.onclick = () => {
    if (current < audios.length - 1) {
        current++;
        if (audioElem) audioElem.pause();
        playNext();
    }
};

// --- Atajos de teclado ---
document.addEventListener('keydown', function(e) {
    if (e.target === textInput && !(e.code === 'Space' || e.code === 'ArrowRight' || e.code === 'ArrowLeft' || (e.code === 'Enter' && e.ctrlKey))) {
        return;
    }
    if (e.code === 'Space') {
        e.preventDefault();
        if (audioElem && !audioElem.paused) {
            pauseBtn.click();
        } else if (audioElem && isPaused) {
            resumeBtn.click();
        }
    } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (current < audios.length - 1) {
            current++;
            playNext();
        }
    } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (current > 0) {
            current--;
            playNext();
        }
    } else if (e.code === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        const cursor = textInput.selectionStart;
        const text = textInput.value;
        if (textParts.length === 0) {
            textParts = getPartsFromText(text);
        }
        let paraIdx = 0;
        let position = 0;
        for (let i = 0; i < textParts.length; i++) {
            const partLength = textParts[i].length;
            const partPosition = text.indexOf(textParts[i], position);
            if (partPosition !== -1 && cursor >= partPosition && cursor <= partPosition + partLength) {
                paraIdx = i;
                break;
            }
            if (partPosition !== -1) {
                position = partPosition + partLength;
            }
        }
        jumpToPart(paraIdx);
    }
});

// --- Lógica principal de reproducción ---
form.onsubmit = async (e) => {
    e.preventDefault();
    textInput.readOnly = true;
    cancelRequested = false;
    isPaused = false;
    pauseBtn.style.display = '';
    resumeBtn.style.display = 'none';
    audioContainer.innerHTML = '';
    clearHighlight();
    await fetch('/clear_cache', { method: 'POST' });
    const text = textInput.value.trim();
    if (!text) {
        showError('Por favor ingresa texto para leer');
        textInput.readOnly = false;
        return;
    }
    updateStatus('Procesando texto...');
    textParts = getPartsFromText(text);
    let data;
    try {
        const res = await fetch('/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        data = await res.json();
    } catch (err) {
        showError('Error de conexión con el servidor.');
        updateStatus('Error de conexión.');
        textInput.readOnly = false;
        return;
    }
    if (!data.audio_urls || !data.audio_urls.length) {
        showError('No se pudo generar el audio.');
        updateStatus('No se pudo generar el audio.');
        textInput.readOnly = false;
        return;
    }
    current = 0;
    audios = data.audio_urls;
    audioElem = document.getElementById('mainAudio');
    if (!audioElem) {
        audioElem = document.createElement('audio');
        audioElem.id = 'mainAudio';
        audioElem.controls = true;
        audioElem.style.width = '100%';
        audioContainer.appendChild(audioElem);
    }
    async function waitForAudio(url) {
        updateStatus('Preparando audio...');
        for (let i = 0; i < 60; i++) {
            if (cancelRequested) return false;
            try {
                const resp = await fetch(url, { method: 'HEAD' });
                if (resp.ok) return true;
            } catch (error) {}
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    }
    window.playNext = async function playNext() {
        if (cancelRequested) return;
        if (current < audios.length && current < textParts.length) {
            highlightParagraph(current);
            updateStatus(`Cargando parte ${current + 1} de ${textParts.length}...`);
            const url = audios[current];
            const ready = await waitForAudio(url);
            if (ready) {
                audioElem.src = url;
                audioElem.play();
                updateStatus(`Reproduciendo parte ${current + 1} de ${textParts.length}`);
            } else {
                updateStatus(`Error al cargar la parte ${current + 1}`);
                audioContainer.insertAdjacentHTML('beforeend', `<div class='text-danger mb-2'>No se pudo cargar el audio para la parte ${current + 1}.</div>`);
            }
        } else if (current >= audios.length) {
            clearHighlight();
            updateStatus('Reproducción completada');
            textInput.readOnly = false;
        }
    }
    audioElem.onended = async () => {
        if (isPaused) return;
        if (current < audios.length) {
            await fetch('/delete_audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: audios[current] })
            });
        }
        current++;
        playNext();
    };
    playNext();
};

// --- Manejo de PDF ---
pdfInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pdfStatus.textContent = 'Analizando PDF...';
    updateStatus('Procesando archivo PDF...');
    const formData = new FormData();
    formData.append('file', file);
    try {
        const res = await fetch('/upload_pdf', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.text) {
            textInput.value = data.text;
            pdfStatus.textContent = 'PDF cargado con éxito';
            updateStatus('PDF cargado. Listo para reproducir.');
        } else {
            pdfStatus.textContent = 'No se pudo leer el PDF.';
            updateStatus('Error al procesar el PDF');
            showError('No se pudo extraer el texto del PDF.');
        }
    } catch (error) {
        pdfStatus.textContent = 'Error al procesar el PDF.';
        updateStatus('Error al procesar el PDF');
        showError('Error al procesar el archivo PDF.');
        console.error(error);
    }
};
