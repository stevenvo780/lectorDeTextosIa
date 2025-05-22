from flask import Flask, render_template, request, jsonify, send_file, abort
import os
import threading
import uuid
import edge_tts
import asyncio
from pydub import AudioSegment
from threading import Thread
from queue import Queue
from werkzeug.utils import secure_filename
import tempfile
import fitz  # PyMuPDF
import time
import re

app = Flask(__name__)
UPLOAD_FOLDER = 'audio_cache'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# --- Utilidades de limpieza y manejo de archivos ---
cleanup_queue = Queue()

def cleanup_worker():
    while True:
        filename = cleanup_queue.get()
        try:
            if os.path.exists(filename):
                os.remove(filename)
        except Exception:
            pass
        cleanup_queue.task_done()

Thread(target=cleanup_worker, daemon=True).start()

def clean_old_files(max_age=3600):
    """Elimina archivos .mp3 antiguos en el cache."""
    now = time.time()
    for f in os.listdir(UPLOAD_FOLDER):
        if f.endswith('.mp3'):
            path = os.path.join(UPLOAD_FOLDER, f)
            try:
                if os.path.getmtime(path) < now - max_age:
                    os.remove(path)
            except Exception:
                pass

# --- Utilidades de texto y TTS ---
def split_text(text, max_length=300):
    """Divide el texto en partes manejables para TTS."""
    sentences = re.split(r'(?<=[.!?]) +', text)
    parts, current = [], ''
    for s in sentences:
        if len(current) + len(s) < max_length:
            current += ' ' + s
        else:
            if current:
                parts.append(current.strip())
            current = s
    if current:
        parts.append(current.strip())
    return parts

async def tts_edge(text, filename):
    communicate = edge_tts.Communicate(text, "es-ES-AlvaroNeural")
    await communicate.save(filename)

def generate_audio_async(text, filename):
    try:
        asyncio.run(tts_edge(text, filename))
    except Exception as e:
        # Loguear el error y evitar archivos corruptos
        if os.path.exists(filename):
            try:
                os.remove(filename)
            except Exception:
                pass
        print(f"Error generando audio: {e}")

def get_text_parts(text, min_length=5):
    # Replica la lógica de /split para dividir el texto en partes
    parts = re.split(r'(?:^|\n)(#+ .+)', text)
    merged, buf = [], ''
    for part in parts:
        if part.strip().startswith('#'):
            if buf.strip():
                merged.append(buf.strip())
            buf = part.strip()
        else:
            buf += '\n' + part
    if buf.strip():
        merged.append(buf.strip())
    if len(merged) <= 1:
        merged = [p.strip() for p in re.split(r'\n\n+', text) if p.strip()]
    # Filtrar fragmentos vacíos o muy cortos
    merged = [p for p in merged if len(p.strip()) >= min_length]
    return merged

# --- Rutas Flask ---
@app.before_request
def before_request():
    clean_old_files()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/split', methods=['POST'])
def split():
    text = request.json.get('text', '')
    # Separar por títulos markdown y saltos dobles de línea
    parts = re.split(r'(?:^|\n)(#+ .+)', text)
    merged, buf = [], ''
    for part in parts:
        if part.strip().startswith('#'):
            if buf.strip():
                merged.append(buf.strip())
            buf = part.strip()
        else:
            buf += '\n' + part
    if buf.strip():
        merged.append(buf.strip())
    if len(merged) <= 1:
        merged = [p.strip() for p in re.split(r'\n\n+', text) if p.strip()]
    return jsonify({'parts': merged})

@app.route('/tts', methods=['POST'])
def tts():
    text = request.json.get('text', '')
    parts = get_text_parts(text)
    if not parts:
        return jsonify({'audio_urls': [], 'error': 'No hay fragmentos válidos para leer.'}), 400
    audio_ids = [str(uuid.uuid4()) for _ in parts]
    filenames = [os.path.join(UPLOAD_FOLDER, f'{audio_id}.mp3') for audio_id in audio_ids]
    # Procesar la primera parte de forma síncrona
    if parts:
        generate_audio_async(parts[0], filenames[0])
    # Las siguientes partes en segundo plano
    def process_part(part, filename):
        generate_audio_async(part, filename)
    for part, filename in zip(parts[1:], filenames[1:]):
        thread = threading.Thread(target=process_part, args=(part, filename), daemon=True)
        thread.start()
    audio_urls = [f'/audio/{os.path.basename(f)}' for f in filenames]
    return jsonify({'audio_urls': audio_urls})

@app.route('/audio/<filename>')
def audio(filename):
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    if not os.path.exists(filepath):
        return abort(404)
    return send_file(filepath, mimetype='audio/mpeg')

@app.route('/delete_audio', methods=['POST'])
def delete_audio():
    url = request.json.get('url', '')
    filename = url.split('/')[-1]
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    cleanup_queue.put(filepath)
    return jsonify({'deleted': True})

@app.route('/clear_cache', methods=['POST'])
def clear_cache():
    deleted = 0
    for f in os.listdir(UPLOAD_FOLDER):
        if f.endswith('.mp3'):
            try:
                os.remove(os.path.join(UPLOAD_FOLDER, f))
                deleted += 1
            except Exception:
                pass
    return jsonify({'cleared': deleted})

@app.route('/export_all', methods=['POST'])
def export_all():
    files = [f for f in os.listdir(UPLOAD_FOLDER) if f.endswith('.mp3')]
    files = sorted(files, key=lambda x: os.path.getctime(os.path.join(UPLOAD_FOLDER, x)))
    valid_files = []
    for f in files:
        path = os.path.join(UPLOAD_FOLDER, f)
        try:
            if os.path.getsize(path) > 1024:
                # Verificar que el archivo no esté corrupto
                AudioSegment.from_mp3(path)
                valid_files.append(f)
        except Exception:
            continue
    if not valid_files:
        return jsonify({'export_url': None, 'error': 'No hay audios válidos para exportar.'})
    # Esperar a que todos los audios estén listos (máx 60s)
    start = time.time()
    while True:
        all_ready = all(os.path.exists(os.path.join(UPLOAD_FOLDER, f)) and os.path.getsize(os.path.join(UPLOAD_FOLDER, f)) > 1024 for f in valid_files)
        if all_ready or (time.time() - start) > 60:
            break
        time.sleep(0.5)
    # Revalidar
    valid_files2 = []
    for f in valid_files:
        path = os.path.join(UPLOAD_FOLDER, f)
        try:
            AudioSegment.from_mp3(path)
            valid_files2.append(f)
        except Exception:
            continue
    if not valid_files2:
        return jsonify({'export_url': None, 'error': 'No hay audios válidos para exportar.'})
    combined = AudioSegment.empty()
    for f in valid_files2:
        combined += AudioSegment.from_mp3(os.path.join(UPLOAD_FOLDER, f))
    export_id = str(uuid.uuid4())
    export_path = os.path.join(UPLOAD_FOLDER, f'export_{export_id}.mp3')
    combined.export(export_path, format="mp3")
    return jsonify({'export_url': f'/audio/{os.path.basename(export_path)}'})

@app.route('/repeat_part', methods=['POST'])
def repeat_part():
    idx = request.json.get('idx')
    text = request.json.get('text')
    parts = get_text_parts(text)
    if idx is None or idx < 0 or idx >= len(parts):
        return jsonify({'error': 'Índice fuera de rango'}), 400
    audio_id = str(uuid.uuid4())
    filename = os.path.join(UPLOAD_FOLDER, f'{audio_id}.mp3')
    generate_audio_async(parts[idx], filename)
    return jsonify({'audio_url': f'/audio/{audio_id}.mp3'})

# --- Manejo de PDF ---
ALLOWED_EXTENSIONS = {'pdf'}
def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/upload_pdf', methods=['POST'])
def upload_pdf():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        with tempfile.NamedTemporaryFile(delete=False, suffix='.pdf') as tmp:
            file.save(tmp.name)
            doc = fitz.open(tmp.name)
            text = "\n\n".join([page.get_text("text") for page in doc])
            doc.close()
        os.remove(tmp.name)
        return jsonify({'text': text})
    return jsonify({'error': 'Invalid file'}), 400

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0')
