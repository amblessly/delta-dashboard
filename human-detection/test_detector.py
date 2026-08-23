import cv2
from ultralytics import YOLO
import time

model = YOLO("yolov8n.pt")
cap = cv2.VideoCapture(0)
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

print("Testing detection for 5 seconds...")
start = time.time()
while time.time() - start < 5:
    ret, frame = cap.read()
    if not ret:
        continue
    results = model(frame, classes=[0], conf=0.5, verbose=False)
    human = any(r.boxes is not None and len(r.boxes) > 0 for r in results)
    print(f"Human detected: {human}")
    time.sleep(0.5)

cap.release()
print("Test complete")