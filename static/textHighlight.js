// textHighlight.js - Funciones de resaltado y scroll de texto

export function highlightParagraph(textInput, highlightOverlay, textParts, paragraphIndex) {
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
    // Mejor scroll: calcula la posición del fragmento resaltado y scrollea suavemente
    setTimeout(() => {
        const overlayRect = highlightOverlay.getBoundingClientRect();
        const highlightRect = highlightSpan.getBoundingClientRect();
        if (highlightRect && overlayRect) {
            const scrollTop = highlightOverlay.scrollTop + (highlightRect.top - overlayRect.top) - overlayRect.height/4;
            highlightOverlay.scrollTo({ top: scrollTop, behavior: 'smooth' });
            textInput.scrollTo({ top: scrollTop, behavior: 'smooth' });
        }
    }, 50);
}

export function clearHighlight(highlightOverlay) {
    highlightOverlay.innerHTML = '';
}
