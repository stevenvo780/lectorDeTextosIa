// uiUtils.js - Utilidades de UI

export function showError(msg) {
    const alert = document.createElement('div');
    alert.className = 'alert alert-danger alert-dismissible fade show position-fixed';
    alert.role = 'alert';
    alert.style = 'bottom: 20px; right: 20px; max-width: 400px; z-index: 9999;';
    alert.innerHTML = msg + '<button type="button" class="btn-close" data-bs-dismiss="alert"></button>';
    document.body.appendChild(alert);
    setTimeout(() => alert.remove(), 6000);
}

export function updateStatus(statusBar, message) {
    statusBar.textContent = message;
}
