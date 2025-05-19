from flask import Flask, render_template, request, jsonify, send_file, abort, send_from_directory
import os
import threading
import uuid
import edge_tts
import asyncio
from pydub import AudioSegment
from threading import Thread
from queue import Queue

app = Flask(__name__)
UPLOAD_FOLDER = 'audio_cache'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Cola para borrar archivos después de exportar
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

# Inicia el hilo de limpieza al arrancar la app
Thread(target=cleanup_worker, daemon=True).start()

# Divide el texto en partes (puedes mejorar el split según tu preferencia)
def split_text(text, max_length=300):
    import re
    sentences = re.split(r'(?<=[.!?]) +', text)
    parts = []
    current = ''
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
    asyncio.run(tts_edge(text, filename))

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/split', methods=['POST'])
def split():
    text = request.json.get('text', '')
    parts = split_text(text)
    return jsonify({'parts': parts})

@app.route('/tts', methods=['POST'])
def tts():
    text = request.json.get('text', '')
    parts = split_text(text)
    audio_ids = [str(uuid.uuid4()) for _ in parts]
    filenames = [os.path.join(UPLOAD_FOLDER, f'{audio_id}.mp3') for audio_id in audio_ids]
    # Procesar la primera parte de forma síncrona
    if parts:
        generate_audio_async(parts[0], filenames[0])
    # Las siguientes partes en segundo plano
    def process_part(part, filename):
        generate_audio_async(part, filename)
    for part, filename in zip(parts[1:], filenames[1:]):
        thread = threading.Thread(target=process_part, args=(part, filename))
        thread.daemon = True
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
    # En vez de borrar inmediatamente, lo ponemos en la cola
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
    # Une todos los audios actuales en el cache en orden de creación
    files = [f for f in os.listdir(UPLOAD_FOLDER) if f.endswith('.mp3')]
    files = sorted(files, key=lambda x: os.path.getctime(os.path.join(UPLOAD_FOLDER, x)))
    valid_files = []
    for f in files:
        path = os.path.join(UPLOAD_FOLDER, f)
        try:
            if os.path.getsize(path) > 1024:  # Solo archivos mayores a 1KB
                # Prueba si se puede abrir
                AudioSegment.from_mp3(path)
                valid_files.append(f)
        except Exception:
            continue
    if not valid_files:
        return jsonify({'export_url': None})
    combined = AudioSegment.empty()
    for f in valid_files:
        combined += AudioSegment.from_mp3(os.path.join(UPLOAD_FOLDER, f))
    export_id = str(uuid.uuid4())
    export_path = os.path.join(UPLOAD_FOLDER, f'export_{export_id}.mp3')
    combined.export(export_path, format="mp3")
    return jsonify({'export_url': f'/audio/{os.path.basename(export_path)}'})

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0')
