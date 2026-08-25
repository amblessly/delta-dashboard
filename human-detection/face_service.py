"""
Face Detection & Embedding Service for Project DELTA (Raspberry Pi side).

Uses InsightFace (buffalo_l) for face DETECTION and EMBEDDING only.
This service deliberately does NOT store students or decide identity:
enrollment and matching live in the Project DELTA backend
(Node.js / Vercel API + PostgreSQL), which owns the sequential Student IDs.

The browser dashboard performs recognition through:
    POST /api/face/match  (backend)
so this Python service is an optional accelerator for Raspberry Pi
camera pipelines that need server-side detection/embedding.

Endpoints:
  GET  /health            - health check (model loaded?)
  POST /api/face/detect   - detect faces in a base64 image
                            -> single_face | no_face | multiple_faces | unclear,
                               with a 512-d InsightFace embedding when clear
"""

import os
import sys
import base64
import logging
import threading

import numpy as np
import cv2
from flask import Flask, request, jsonify
from flask_cors import CORS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# Global face analysis model
face_app = None
face_lock = threading.Lock()

# Minimum detection confidence to accept a face as "clear"
MIN_CONFIDENCE = 0.5


def init_face_model():
    """Initialize the InsightFace model."""
    global face_app
    try:
        from insightface.app import FaceAnalysis
        logger.info("Initializing InsightFace model...")

        providers = ['CPUExecutionProvider']

        face_app = FaceAnalysis(
            name='buffalo_l',
            providers=providers,
            allowed_modules=['detection', 'recognition']
        )
        face_app.prepare(ctx_id=0, det_size=(640, 480))
        logger.info("InsightFace model initialized successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to initialize InsightFace: {e}")
        return False


def decode_image(image_data):
    """Decode base64 image data to OpenCV format."""
    try:
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        img_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(img_bytes, np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    except Exception as e:
        logger.error(f"Image decode error: {e}")
        return None


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({
        'status': 'ok',
        'service': 'face-detection',
        'model_loaded': face_app is not None
    })


@app.route('/api/face/detect', methods=['POST'])
def detect_face():
    """
    Detect face(s) in an image and return quality + embedding.
    Request body: { "image": "base64_encoded_image" }
    Response: {
        "status": "single_face" | "no_face" | "multiple_faces" | "unclear",
        "embedding": [512 floats] or null,
        "confidence": float,
        "bbox": [x1, y1, x2, y2]
    }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'error': 'image field required'}), 400

        image = decode_image(data['image'])
        if image is None:
            return jsonify({'error': 'Invalid image data'}), 400

        with face_lock:
            if face_app is None:
                return jsonify({'error': 'Face model not initialized'}), 500

            faces = face_app.get(image)

            if len(faces) == 0:
                return jsonify({
                    'status': 'no_face',
                    'embedding': None,
                    'confidence': 0,
                    'bbox': None
                })

            if len(faces) > 1:
                return jsonify({
                    'status': 'multiple_faces',
                    'embedding': None,
                    'confidence': 0,
                    'bbox': None
                })

            face = faces[0]
            embedding = face.embedding.tolist()
            confidence = float(face.det_score)
            bbox = face.bbox.astype(int).tolist()

            if confidence < MIN_CONFIDENCE:
                return jsonify({
                    'status': 'unclear',
                    'embedding': None,
                    'confidence': confidence,
                    'bbox': bbox
                })

            return jsonify({
                'status': 'single_face',
                'embedding': embedding,
                'confidence': confidence,
                'bbox': bbox
            })

    except Exception as e:
        logger.error(f"Face detection error: {e}")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    if not init_face_model():
        logger.error("Failed to initialize face model. Exiting.")
        sys.exit(1)

    logger.info("Starting Face Detection Service on port 8001...")
    app.run(host='0.0.0.0', port=8001, debug=False)
