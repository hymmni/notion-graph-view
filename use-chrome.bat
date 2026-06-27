@echo off
copy /Y manifest-chrome.json manifest.json
echo [Chrome] manifest.json 전환 완료. chrome://extensions 에서 확장앱을 새로고침하세요.
pause
