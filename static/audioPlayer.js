// audioPlayer.js - Control de reproducción de audio y velocidad

export class AudioPlayer {
    constructor(audioElem, onEnded) {
        this.audioElem = audioElem;
        this.onEnded = onEnded;
        this.speed = 1.0;
        if (onEnded) {
            this.audioElem.onended = onEnded;
        }
    }
    setSource(url) {
        this.audioElem.src = url;
    }
    play() {
        this.audioElem.play();
    }
    pause() {
        this.audioElem.pause();
    }
    setSpeed(rate) {
        this.speed = rate;
        this.audioElem.playbackRate = rate;
    }
    getSpeed() {
        return this.audioElem.playbackRate;
    }
    isPaused() {
        return this.audioElem.paused;
    }
    stop() {
        this.audioElem.pause();
        this.audioElem.currentTime = 0;
    }
}
