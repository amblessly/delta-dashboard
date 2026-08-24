"""
Face Detection & Recognition Service for Project DELTA
Uses InsightFace for face detection and recognition.
Exposes Flask endpoints for dashboard integration.

Endpoints:
  POST /api/face/detect    - Detect face in image, return embedding
  POST /api/face/enroll    - Enroll a new student with face embedding
  GET  /api/students       - List all enrolled students
  GET  /health             - Health check
"""

import os
import sys
import json
import base64
import logging
import time
import threading
import numpy as np
import cv2
from flask import Flask, request, jsonify
from flask_cors import CORS

# Add the parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# Global face analysis model
face_app = None
face_lock = threading.Lock()

# In-memory student database (will be synced with PostgreSQL via Node.js server)
students_db = {}
students_lock = threading.Lock()

# Face recognition threshold
MATCH_THRESHOLD = 0.4  # InsightFace uses cosine similarity (higher is better)

def init_face_model():
    """Initialize the InsightFace model."""
    global face_app
    try:
        from insightface.app import FaceAnalysis
        logger.info("Initializing InsightFace model...")
        
        # Use CPU if CUDA not available
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
        # Remove data URL prefix if present
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        
        # Decode base64
        img_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        return img
    except Exception as e:
        logger.error(f"Image decode error: {e}")
        return None

def cosine_similarity(a, b):
    """Calculate cosine similarity between two vectors."""
    a = np.array(a)
    b = np.array(b)
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

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
    Detect face in image and return embedding.
    Request body: { "image": "base64_encoded_image" }
    Response: {
        "status": "face_detected" | "no_face" | "multiple_faces" | "unclear",
        "embedding": [128 floats] or null,
        "confidence": float,
        "bbox": [x, y, w, h]
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
            
            # Detect faces
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
            
            # Single face detected
            face = faces[0]
            embedding = face.embedding.tolist()
            confidence = float(face.det_score)
            bbox = face.bbox.astype(int).tolist()
            
            # Check face quality
            if confidence < 0.5:
                return jsonify({
                    'status': 'unclear',
                    'embedding': None,
                    'confidence': confidence,
                    'bbox': bbox
                })
            
            return jsonify({
                'status': 'face_detected',
                'embedding': embedding,
                'confidence': confidence,
                'bbox': bbox
            })
    
    except Exception as e:
        logger.error(f"Face detection error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/face/match', methods=['POST'])
def match_face():
    """
    Match a face embedding against enrolled students.
    Request body: { "embedding": [128 floats] }
    Response: {
        "matched": true/false,
        "student": {...} or null,
        "confidence": float
    }
    """
    try:
        data = request.get_json()
        if not data or 'embedding' not in data:
            return jsonify({'error': 'embedding field required'}), 400
        
        embedding = np.array(data['embedding'])
        if embedding.shape != (128,):
            return jsonify({'error': 'Embedding must be 128-dimensional'}), 400
        
        with students_lock:
            best_match = None
            best_score = -1
            
            for student_id, student in students_db.items():
                for enrolled_emb in student.get('embeddings', []):
                    enrolled_emb = np.array(enrolled_emb)
                    score = cosine_similarity(embedding, enrolled_emb)
                    
                    if score > best_score:
                        best_score = score
                        best_match = student
            
            if best_match and best_score >= MATCH_THRESHOLD:
                return jsonify({
                    'matched': True,
                    'student': {
                        'id': best_match['id'],
                        'name': best_match['name'],
                        'age': best_match.get('age'),
                        'weight_kg': best_match.get('weight_kg'),
                        'photo': best_match.get('photo')
                    },
                    'confidence': float(best_score)
                })
            else:
                return jsonify({
                    'matched': False,
                    'student': None,
                    'confidence': float(best_score) if best_score >= 0 else 0
                })
    
    except Exception as e:
        logger.error(f"Face matching error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/face/enroll', methods=['POST'])
def enroll_student():
    """
    Enroll a new student with face embedding.
    Request body: {
        "name": "Student Name",
        "embedding": [128 floats],
        "age": 20,
        "weight_kg": 65.5,
        "photo": "base64_image" (optional)
    }
    Response: {
        "id": int,
        "name": str,
        "age": int,
        "weight_kg": float,
        "enrolled": true
    }
    """
    try:
        data = request.get_json()
        if not data or 'name' not in data or 'embedding' not in data:
            return jsonify({'error': 'name and embedding fields required'}), 400
        
        name = data['name'].strip()
        if not name:
            return jsonify({'error': 'Name cannot be empty'}), 400
        
        embedding = data['embedding']
        if not isinstance(embedding, list) or len(embedding) != 128:
            return jsonify({'error': 'Embedding must be 128-dimensional array'}), 400
        
        # Generate unique ID
        with students_lock:
            student_id = max(students_db.keys(), default=0) + 1
            
            student = {
                'id': student_id,
                'name': name,
                'age': data.get('age'),
                'weight_kg': data.get('weight_kg'),
                'photo': data.get('photo'),
                'embeddings': [embedding]
            }
            
            students_db[student_id] = student
            logger.info(f"Enrolled student: {name} (ID: {student_id})")
            
            return jsonify({
                'id': student_id,
                'name': name,
                'age': student.get('age'),
                'weight_kg': student.get('weight_kg'),
                'photo': student.get('photo'),
                'enrolled': True
            })
    
    except Exception as e:
        logger.error(f"Student enrollment error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/students', methods=['GET'])
def list_students():
    """
    List all enrolled students.
    Response: [
        {
            "id": int,
            "name": str,
            "age": int,
            "weight_kg": float,
            "embeddings": [[128 floats]]
        }
    ]
    """
    try:
        with students_lock:
            students_list = list(students_db.values())
            return jsonify(students_list)
    except Exception as e:
        logger.error(f"List students error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/students/<int:student_id>', methods=['GET'])
def get_student(student_id):
    """
    Get a specific student by ID.
    Response: {
        "id": int,
        "name": str,
        "age": int,
        "weight_kg": float,
        "embeddings": [[128 floats]]
    }
    """
    try:
        with students_lock:
            student = students_db.get(student_id)
            if student:
                return jsonify(student)
            else:
                return jsonify({'error': 'Student not found'}), 404
    except Exception as e:
        logger.error(f"Get student error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/students/<int:student_id>', methods=['DELETE'])
def delete_student(student_id):
    """
    Delete a student by ID.
    """
    try:
        with students_lock:
            if student_id in students_db:
                del students_db[student_id]
                logger.info(f"Deleted student ID: {student_id}")
                return jsonify({'deleted': True})
            else:
                return jsonify({'error': 'Student not found'}), 404
    except Exception as e:
        logger.error(f"Delete student error: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    # Initialize face model
    if not init_face_model():
        logger.error("Failed to initialize face model. Exiting.")
        sys.exit(1)
    
    logger.info("Starting Face Detection Service on port 8001...")
    app.run(host='0.0.0.0', port=8001, debug=False)
