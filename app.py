import os
import time
import re
import asyncio
import uuid
import edge_tts
import fitz  # PyMuPDF

from flask import Flask, render_template, request, jsonify, send_file, abort
from pydub import AudioSegment
from threading import Thread
from queue import Queue
from werkzeug.utils import secure_filename

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
        except Exception as e:
            print(f"Error eliminando archivo: {e}")
        cleanup_queue.task_done()

Thread(target=cleanup_worker, daemon=True).start()

def clean_old_files(max_age=3600):
    """Elimina archivos .mp3 antiguos en el cache."""
    now = time.time()
    for f in os.listdir(UPLOAD_FOLDER):
        if f.endswith('.mp3'):
            path = os.path.join(UPLOAD_FOLDER, f)
            if os.path.isfile(path) and now - os.path.getmtime(path) > max_age:
                try:
                    os.remove(path)
                except Exception as e:
                    print(f"Error eliminando archivo antiguo: {e}")

# --- Utilidades de texto y TTS ---
def split_text(text, max_length=300):
    """Divide el texto en partes manejables para TTS."""
    sentences = re.split(r'(?<=[.!?]) +', text)
    parts, current = [], ''
    for s in sentences:
        if len(current) + len(s) < max_length:
            current += s + ' '
        else:
            parts.append(current.strip())
            current = s + ' '
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
            os.remove(filename)
        print(f"Error generando audio: {e}")

def get_text_parts(text, min_length=5):
    # Replica la lógica de /split para dividir el texto en partes
    parts = re.split(r'(?:^|\n)(#+ .+)', text)
    merged, buf = [], ''
    for part in parts:
        if part.strip().startswith('#'):
            if buf.strip():
                merged.append(buf.strip())
            buf = part + '\n'
        else:
            buf += part
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
            buf = part + '\n'
        else:
            buf += part
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
        return jsonify({'error': 'No hay partes para sintetizar.'}), 400
    audio_ids = [str(uuid.uuid4()) for _ in parts]
    filenames = [os.path.join(UPLOAD_FOLDER, f'{audio_id}.mp3') for audio_id in audio_ids]
    # Procesar la primera parte de forma síncrona
    if parts:
        generate_audio_async(parts[0], filenames[0])
    # Las siguientes partes en segundo plano
    def process_part(part, filename):
        generate_audio_async(part, filename)
    for part, filename in zip(parts[1:], filenames[1:]):
        Thread(target=process_part, args=(part, filename), daemon=True).start()
    audio_urls = [f'/audio/{os.path.basename(f)}' for f in filenames]
    return jsonify({'audio_urls': audio_urls})

@app.route('/audio/<filename>')
def audio(filename):
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    if not os.path.exists(filepath):
        abort(404)
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
        path = os.path.join(UPLOAD_FOLDER, f)
        if os.path.isfile(path):
            try:
                os.remove(path)
                deleted += 1
            except Exception as e:
                print(f"Error eliminando archivo: {e}")
    return jsonify({'cleared': deleted})

@app.route('/export_all', methods=['POST'])
def export_all():
    files = [f for f in os.listdir(UPLOAD_FOLDER) if f.endswith('.mp3')]
    files = sorted(files, key=lambda x: os.path.getctime(os.path.join(UPLOAD_FOLDER, x)))
    valid_files = []
    for f in files:
        path = os.path.join(UPLOAD_FOLDER, f)
        if os.path.exists(path) and os.path.getsize(path) > 1000:
            valid_files.append(path)
    if not valid_files:
        return jsonify({'error': 'No hay audios para exportar.'}), 400
    # Esperar a que todos los audios estén listos (máx 60s)
    start = time.time()
    while True:
        if all(os.path.exists(f) and os.path.getsize(f) > 1000 for f in valid_files):
            break
        if time.time() - start > 60:
            break
        time.sleep(1)
    # Revalidar
    valid_files2 = []
    for f in valid_files:
        if os.path.exists(f) and os.path.getsize(f) > 1000:
            valid_files2.append(f)
    if not valid_files2:
        return jsonify({'error': 'No hay audios válidos.'}), 400
    combined = AudioSegment.empty()
    for f in valid_files2:
        combined += AudioSegment.from_file(f)
    export_path = os.path.join(UPLOAD_FOLDER, 'export_all.mp3')
    combined.export(export_path, format='mp3')
    return jsonify({'export_url': f'/audio/export_all.mp3'})

@app.route('/repeat_part', methods=['POST'])
def repeat_part():
    # Esta función puede implementarse según la lógica de repetición de un fragmento
    return jsonify({'ok': True})

# --- Manejo de PDF ---
ALLOWED_EXTENSIONS = {'pdf'}
def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/upload_pdf', methods=['POST'])
def upload_pdf():
    if 'file' not in request.files:
        return jsonify({'error': 'No se envió archivo.'}), 400
    file = request.files['file']
    if file.filename == '' or not allowed_file(file.filename):
        return jsonify({'error': 'Archivo no permitido.'}), 400
    filename = secure_filename(file.filename)
    temp_path = os.path.join(UPLOAD_FOLDER, filename)
    file.save(temp_path)
    try:
        doc = fitz.open(temp_path)
        text = ''
        for page in doc:
            text += page.get_text()
        doc.close()
        os.remove(temp_path)
        return jsonify({'text': text})
    except Exception as e:
        print(f"Error leyendo PDF: {e}")
        return jsonify({'error': 'No se pudo leer el PDF.'}), 500

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0')
