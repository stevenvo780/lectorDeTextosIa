import { AudioPlayer } from './audioPlayer.js';
import { highlightParagraph, clearHighlight } from './textHighlight.js';
import { showError, updateStatus } from './uiUtils.js';

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

// --- Selector de velocidad ---
let speedSelector = document.getElementById('speedSelector');
if (!speedSelector) {
    speedSelector = document.createElement('select');
    speedSelector.id = 'speedSelector';
    speedSelector.className = 'form-select my-2';
    [0.75, 1, 1.25, 1.5, 1.75, 2].forEach(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = `Velocidad ${v}x`;
        if (v === 1) opt.selected = true;
        speedSelector.appendChild(opt);
    });
    audioContainer.parentNode.insertBefore(speedSelector, audioContainer.nextSibling);
}

// --- Estado global ---
let cancelRequested = false;
let isPaused = false;
let audioElem = null;
let audioPlayer = null;
let current = 0;
let audios = [];
let textParts = [];

// --- Persistencia con localStorage ---
window.addEventListener('DOMContentLoaded', () => {
    const savedText = localStorage.getItem('lector_text');
    if (savedText) {
        textInput.value = savedText;
    }
    const savedCurrent = localStorage.getItem('lector_current');
    if (savedCurrent) {
        current = parseInt(savedCurrent, 10) || 0;
    }
    const savedParts = localStorage.getItem('lector_parts');
    if (savedParts) {
        try {
            textParts = JSON.parse(savedParts);
        } catch {}
    }
});

textInput.addEventListener('input', () => {
    localStorage.setItem('lector_text', textInput.value);
});

// Guardar el estado de reproducción
function savePlaybackState() {
    localStorage.setItem('lector_current', current);
    localStorage.setItem('lector_parts', JSON.stringify(textParts));
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
    clearHighlight(highlightOverlay);
    audioContainer.innerHTML = '';
    if (audioElem) audioElem.pause();
    updateStatus(statusBar, 'Lectura cancelada');
    textInput.readOnly = false;
    textInput.classList.remove('reading-locked');
    await fetch('/clear_cache', { method: 'POST' });
};
exportBtn.onclick = async () => {
    exportBtn.disabled = true;
    const originalText = exportBtn.innerHTML;
    exportBtn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Exportando...`;
    updateStatus(statusBar, 'Exportando audio...');
    const res = await fetch('/export_all', { method: 'POST' });
    const data = await res.json();
    exportBtn.disabled = false;
    exportBtn.innerHTML = originalText;
    if (data.export_url) {
        const a = document.createElement('a');
        a.href = data.export_url;
        a.download = 'lectura_completa.mp3';
        a.click();
        updateStatus(statusBar, 'Audio exportado con éxito');
    } else {
        updateStatus(statusBar, 'Error al exportar el audio');
        showError('No se pudo exportar el audio.');
    }
};
pauseBtn.onclick = () => {
    if (audioElem && !audioElem.paused) {
        audioElem.pause();
        isPaused = true;
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = '';
        updateStatus(statusBar, 'Reproducción pausada');
    }
};
resumeBtn.onclick = () => {
    if (audioElem && isPaused) {
        audioElem.play();
        isPaused = false;
        pauseBtn.style.display = '';
        resumeBtn.style.display = 'none';
        updateStatus(statusBar, `Reproduciendo parte ${current + 1} de ${textParts.length}`);
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
    textInput.classList.add('reading-locked');
    cancelRequested = false;
    isPaused = false;
    pauseBtn.style.display = '';
    resumeBtn.style.display = 'none';
    audioContainer.innerHTML = '';
    clearHighlight(highlightOverlay);
    await fetch('/clear_cache', { method: 'POST' });
    const text = textInput.value.trim();
    if (!text) {
        showError('Por favor ingresa texto para leer');
        textInput.readOnly = false;
        textInput.classList.remove('reading-locked');
        return;
    }
    updateStatus(statusBar, 'Procesando texto...');
    // 1. Pedir fragmentos reales al backend
    let splitData;
    try {
        const splitRes = await fetch('/split', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        splitData = await splitRes.json();
    } catch (err) {
        showError('Error de conexión con el servidor (split).');
        updateStatus(statusBar, 'Error de conexión.');
        textInput.readOnly = false;
        textInput.classList.remove('reading-locked');
        return;
    }
    if (!splitData.parts || !splitData.parts.length) {
        showError('No se pudo dividir el texto.');
        updateStatus(statusBar, 'No se pudo dividir el texto.');
        textInput.readOnly = false;
        textInput.classList.remove('reading-locked');
        return;
    }
    textParts = splitData.parts;
    // 2. Pedir los audios usando el texto original (el backend usará la misma lógica)
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
        updateStatus(statusBar, 'Error de conexión.');
        textInput.readOnly = false;
        textInput.classList.remove('reading-locked');
        return;
    }
    if (!data.audio_urls || !data.audio_urls.length) {
        showError('No se pudo generar el audio.');
        updateStatus(statusBar, 'No se pudo generar el audio.');
        textInput.readOnly = false;
        textInput.classList.remove('reading-locked');
        return;
    }
    current = 0;
    audios = data.audio_urls;
    localStorage.setItem('lector_text', textInput.value);
    localStorage.setItem('lector_current', 0);
    localStorage.setItem('lector_parts', JSON.stringify(textParts));
    audioElem = document.getElementById('mainAudio');
    if (!audioElem) {
        audioElem = document.createElement('audio');
        audioElem.id = 'mainAudio';
        audioElem.controls = true;
        audioElem.style.width = '100%';
        audioContainer.appendChild(audioElem);
    }
    audioPlayer = new AudioPlayer(audioElem, async () => {
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
    });
    audioPlayer.setSpeed(Number(speedSelector.value));
    speedSelector.onchange = () => {
        audioPlayer.setSpeed(Number(speedSelector.value));
    };
    async function waitForAudio(url) {
        updateStatus(statusBar, 'Preparando audio...');
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
            highlightParagraph(textInput, highlightOverlay, textParts, current);
            updateStatus(statusBar, `Cargando parte ${current + 1} de ${textParts.length}...`);
            const url = audios[current];
            const ready = await waitForAudio(url);
            if (ready) {
                audioPlayer.setSource(url);
                audioPlayer.play();
                updateStatus(statusBar, `Reproduciendo parte ${current + 1} de ${textParts.length}`);
            } else {
                updateStatus(statusBar, `Error al cargar la parte ${current + 1}`);
                audioContainer.insertAdjacentHTML('beforeend', `<div class='text-danger mb-2'>No se pudo cargar el audio para la parte ${current + 1}.</div>`);
            }
        } else if (current >= audios.length) {
            clearHighlight(highlightOverlay);
            updateStatus(statusBar, 'Reproducción completada');
            textInput.readOnly = false;
            textInput.classList.remove('reading-locked');
        }
        savePlaybackState();
    };
    playNext();
};

// --- Manejo de PDF ---
pdfInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pdfStatus.textContent = 'Analizando PDF...';
    updateStatus(statusBar, 'Procesando archivo PDF...');
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
            updateStatus(statusBar, 'PDF cargado. Listo para reproducir.');
        } else {
            pdfStatus.textContent = 'No se pudo leer el PDF.';
            updateStatus(statusBar, 'Error al procesar el PDF');
            showError('No se pudo extraer el texto del PDF.');
        }
    } catch (error) {
        pdfStatus.textContent = 'Error al procesar el PDF.';
        updateStatus(statusBar, 'Error al procesar el PDF');
        showError('Error al procesar el archivo PDF.');
        console.error(error);
    }
};

window.addEventListener('beforeunload', () => {
    savePlaybackState();
});
