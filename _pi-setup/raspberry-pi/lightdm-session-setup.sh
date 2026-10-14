#!/bin/bash
# Force udev to apply touch calibration before labwc session starts
udevadm trigger --subsystem-match=input
udevadm settle
