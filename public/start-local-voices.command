#!/bin/bash

echo "🚀 Starting free local high-quality voices for The Word in Context..."
echo ""

# Check for Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed."
    echo "Please download Docker Desktop (free) and install it first."
    open "https://www.docker.com/products/docker-desktop/"
    read -p "Press Enter after installing Docker, then run this again..."
    exit 1
fi

# Make sure Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "🐳 Starting Docker Desktop..."
    open -a Docker
    echo "Waiting for Docker to be ready (this can take 20-60 seconds)..."
    while ! docker info > /dev/null 2>&1; do
        sleep 3
        echo -n "."
    done
    echo ""
fi

echo "✅ Docker is ready."

# Stop any previous instance
docker rm -f local-voices 2>/dev/null || true

echo "📥 Pulling and starting the voice container (this may take a minute the first time)..."
docker run -d --name local-voices -p 5050:5050 -e REQUIRE_API_KEY=False --restart unless-stopped travisvn/openai-edge-tts:latest

echo ""
echo "🎉 Success! Local voices are now running."
echo ""
echo "In the app:"
echo "1. Click the 🔊 Voice button"
echo "2. In the green box, make sure the URL is: http://localhost:5050"
echo "3. Click Save Settings"
echo ""
echo "All speaking will now use excellent free Microsoft neural voices."
echo ""
echo "To stop later: docker rm -f local-voices"
echo ""
read -p "Press Enter to close this window..."
