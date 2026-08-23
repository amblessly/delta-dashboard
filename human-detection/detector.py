"""
Human Detection Service for Project DELTA
Uses YOLOv8 for person detection, exposes FastAPI endpoint for dashboard integration.
"""
import cv2
import numpy as np
from ultralytics import YOLO
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import threading
import time
from typing import Optional
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Human Detection Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class HumanDetector:
    def __init__(self, model_path: str = "yolov8n.pt", camera_index: int = 1, conf_threshold: float = 0.5):
        self.model = YOLO(model_path)
        self.camera_index = camera_index
        self.conf_threshold = conf_threshold
        self.cap = None
        self.running = False
        self.human_present = False
        self.last_detection_time = 0
        self.detection_lock = threading.Lock()
        
    def start(self):
        """Start the detection loop in a background thread."""
        # Try DSHOW backend on Windows for better compatibility
        self.cap = cv2.VideoCapture(self.camera_index, cv2.CAP_DSHOW)
        if not self.cap.isOpened():
            # Fallback to default
            self.cap = cv2.VideoCapture(self.camera_index)
        if not self.cap.isOpened():
            logger.error(f"Cannot open camera {self.camera_index}")
            return False
        
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        self.cap.set(cv2.CAP_PROP_FPS, 30)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        
        self.running = True
        self.thread = threading.Thread(target=self._detection_loop, daemon=True)
        self.thread.start()
        logger.info("Human detection started")
        return True
    
    def stop(self):
        """Stop the detection loop."""
        self.running = False
        if self.cap:
            self.cap.release()
        logger.info("Human detection stopped")
    
    def _detection_loop(self):
        """Background detection loop."""
        while self.running:
            ret, frame = self.cap.read()
            if not ret:
                time.sleep(0.1)
                continue
            
            # Run YOLO detection (person class = 0)
            results = self.model(frame, classes=[0], conf=self.conf_threshold, verbose=False)
            
            human_detected = False
            for r in results:
                if r.boxes is not None and len(r.boxes) > 0:
                    human_detected = True
                    break
            
            with self.detection_lock:
                self.human_present = human_detected
                if human_detected:
                    self.last_detection_time = time.time()
            
            time.sleep(0.1)  # ~10 FPS detection
    
    def is_human_present(self) -> bool:
        """Check if human is currently detected."""
        with self.detection_lock:
            return self.human_present
    
    def get_status(self) -> dict:
        """Get detailed detection status."""
        with self.detection_lock:
            return {
                "human_present": self.human_present,
                "last_detection": self.last_detection_time,
                "camera_active": self.cap is not None and self.cap.isOpened()
            }

# Global detector instance
detector = HumanDetector()

@app.on_event("startup")
async def startup_event():
    detector.start()

@app.on_event("shutdown")
async def shutdown_event():
    detector.stop()

@app.get("/api/human/status")
async def human_status():
    """Get human detection status."""
    return detector.get_status()

@app.get("/api/human/present")
async def human_present():
    """Simple boolean endpoint for human presence."""
    return {"present": detector.is_human_present()}

@app.get("/health")
async def health():
    return {"status": "ok", "service": "human-detection"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)