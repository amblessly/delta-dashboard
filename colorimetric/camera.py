"""camera.py — Raspberry Pi Camera capture for colorimetric analysis.

Uses Picamera2 + OpenCV to capture controlled, multi-frame image sets
under consistent exposure/white-balance for reliable color measurement.

Supports:
- Locked manual controls (exposure, gain, white-balance)
- Camera warmup frames (discarded before measurement)
- Configurable frame count and delay
- LED illumination control
"""
import json
import time
import threading
import numpy as np
from pathlib import Path

try:
    from picamera2 import Picamera2
    _HAS_PICAMERA = True
except ImportError:
    _HAS_PICAMERA = False

try:
    import cv2
    _HAS_CV2 = True
except ImportError:
    _HAS_CV2 = False


_DEFAULT_CONFIG_DIR = Path(__file__).parent / "config"
_DEFAULT_CAM_CONFIG = _DEFAULT_CONFIG_DIR / "camera_config.json"


def load_camera_config(config_path=None):
    """Load camera configuration from JSON file."""
    path = Path(config_path) if config_path else _DEFAULT_CAM_CONFIG
    if not path.exists():
        return {}
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


class ColorimetricCamera:
    """Manages Pi Camera for controlled colorimetric capture.

    Locks exposure, gain, and white-balance to ensure consistent
    color measurement across frames. Includes warmup frame discard.
    """

    def __init__(self, config=None):
        if not _HAS_PICAMERA:
            raise RuntimeError("picamera2 not available")
        if not _HAS_CV2:
            raise RuntimeError("opencv not available")

        self._cfg = config or load_camera_config()
        self._resolution = tuple(self._cfg.get("resolution", [1640, 1232]))
        self._picam = None
        self._lock = threading.Lock()
        self._started = False

    def start(self):
        """Initialize camera with locked manual controls."""
        if self._started:
            return
        self._picam = Picamera2()
        cam_config = self._picam.create_still_configuration(
            main={"size": self._resolution, "format": self._cfg.get("format", "RGB888")},
            raw=self._picam.sensor_modes[0] if self._picam.sensor_modes else None,
        )
        self._picam.configure(cam_config)

        # Lock manual controls from config
        controls = {
            "ExposureTime": self._cfg.get("exposure_time", 30000),
            "AnalogueGain": self._cfg.get("analogue_gain", 1.0),
            "AwbEnable": self._cfg.get("awb_enable", False),
            "AwbMode": self._cfg.get("awb_mode", 0),
            "ColourGains": tuple(self._cfg.get("colour_gains", [1.4, 1.5])),
        }
        try:
            self._picam.set_controls(controls)
        except Exception:
            pass

        self._picam.start()
        # Warmup: capture and discard several frames for AE/AWB/exposure to settle
        warmup_frames = self._cfg.get("warmup_frames", 5)
        warmup_delay = self._cfg.get("warmup_delay_ms", 200) / 1000.0
        for _ in range(warmup_frames):
            try:
                self._picam.capture_array()
            except Exception:
                pass
            time.sleep(warmup_delay)

        # Control LED if supported
        if self._cfg.get("enable_led", True):
            try:
                self._picam.set_controls({"LedEnable": True})
            except Exception:
                pass

        self._started = True

    def stop(self):
        """Release camera."""
        if self._picam and self._started:
            try:
                self._picam.set_controls({"LedEnable": False})
            except Exception:
                pass
            self._picam.stop()
            self._picam.close()
            self._picam = None
            self._started = False

    def capture_frames(self, count=None, delay_ms=None):
        """Capture multiple frames for measurement.

        Args:
            count: Number of frames (default from config).
            delay_ms: Delay between frames in ms (default from config).

        Returns:
            List of numpy arrays (RGB), or empty list on failure.
        """
        if not self._started:
            self.start()

        count = count or self._cfg.get("capture_frames", 20)
        delay_ms = delay_ms if delay_ms is not None else self._cfg.get("capture_delay_ms", 100)

        frames = []
        with self._lock:
            for i in range(count):
                try:
                    frame = self._picam.capture_array()
                    if frame is not None and frame.size > 0:
                        frames.append(frame.copy())
                except Exception:
                    continue
                if i < count - 1:
                    time.sleep(delay_ms / 1000.0)
        return frames

    def capture_single(self):
        """Capture a single frame. Returns numpy array or None."""
        frames = self.capture_frames(count=1)
        return frames[0] if frames else None

    def capture_raw_bgr(self, count=None, delay_ms=None):
        """Capture frames as BGR (OpenCV default format)."""
        rgb_frames = self.capture_frames(count=count, delay_ms=delay_ms)
        return [cv2.cvtColor(f, cv2.COLOR_RGB2BGR) for f in rgb_frames]

    @property
    def is_started(self):
        return self._started

    @property
    def available(self):
        return _HAS_PICAMERA and _HAS_CV2

    @property
    def config(self):
        return dict(self._cfg)


class DummyCamera:
    """Fallback camera that generates test images when no Pi Camera is available."""

    def __init__(self):
        self._started = False
        self._cfg = load_camera_config()

    def start(self):
        self._started = True

    def stop(self):
        self._started = False

    def capture_frames(self, count=5, delay_ms=200):
        frames = []
        for _ in range(count):
            img = np.random.randint(0, 255, (600, 800, 3), dtype=np.uint8)
            frames.append(img)
        return frames

    def capture_single(self):
        frames = self.capture_frames(count=1)
        return frames[0] if frames else None

    def capture_raw_bgr(self, count=5, delay_ms=200):
        return self.capture_frames(count=count, delay_ms=delay_ms)

    @property
    def is_started(self):
        return self._started

    @property
    def available(self):
        return True

    @property
    def config(self):
        return dict(self._cfg)


def create_camera(**kwargs):
    """Factory: returns ColorimetricCamera if available, else DummyCamera."""
    config = kwargs.pop("config", None) or load_camera_config()
    if _HAS_PICAMERA and _HAS_CV2:
        try:
            cam = ColorimetricCamera(config=config, **kwargs)
            return cam
        except Exception:
            pass
    return DummyCamera()
