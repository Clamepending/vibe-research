---
id: connect-cameras
title: Connect your cameras
buildingId: browser-use
summary: Give Vibe Research access to the camera so browser-use agents can capture and see the world.
priority: normal
order: 20
---

# Connect your cameras

Some buildings — in particular `browser-use` — need access to the macOS camera so agents can capture screenshots or drive browser sessions that require the webcam. Grant the permission once and macOS remembers it.

## 1. Grant camera access in System Settings

Open **System Settings → Privacy & Security → Camera**. Find Vibe Research (or the terminal / Electron host running it) in the list and flip the switch on. If the app is not in the list yet, it will be added the first time it requests access.

## 2. Let the app prompt you on first use

Start a browser-use session. macOS will show a one-time permission dialog the first time the helper tries to open the camera — click **OK**. Denying it here hides Vibe Research from the camera list, and you will need to re-enable it in System Settings.

## 3. Enable the browser-use building

Open Agent Town and place the **browser-use** functional building, or enable it from Settings. Once the building is active, agents can request camera frames through the `browser-use` helper.

## 4. Verify

Run a short browser-use task that takes a screenshot. If the capture is black or empty, re-check the Camera toggle in Privacy & Security.
