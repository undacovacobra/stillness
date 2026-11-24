(function () {
  'use strict';
  const Context = window.AudioContext || window.webkitAudioContext;
  const buffers = new Map();
  let context;
  let output;
  let voice;
  let voiceGain;

  function getContext() {
    if (!Context) throw new Error('Web Audio is unavailable.');
    if (!context) context = new Context();
    return context;
  }

  function getOutput() {
    if (!output) {
      const audio = getContext();
      output = audio.createGain();
      output.connect(audio.destination);
    }
    return output;
  }

  function setVoiceVolume(element, volume) {
    if (voice === element) voiceGain.gain.value = volume;
    else element.volume = volume;
  }

  function playVoice(element) {
    if (voice !== element) return element.play();
    return Promise.all([unlock(), element.play()]);
  }

  function record(element) {
    if (!Context || !window.MediaRecorder) return null;
    try {
      const audio = getContext();
      const mix = getOutput();
      const tap = audio.createMediaStreamDestination();
      const recorder = window.StillnessRecordings.capture(tap.stream);
      if (!voice) {
        const gain = audio.createGain();
        gain.gain.value = element.volume;
        gain.connect(mix);
        audio.createMediaElementSource(element).connect(gain);
        voice = element;
        voiceGain = gain;
        element.volume = 1;
      }
      mix.connect(tap);
      let recording;
      return {
        setRunning: running => recorder.setRunning(running),
        finish() {
          if (!recording) {
            recording = recorder.finish().finally(() => {
              mix.disconnect(tap);
              tap.stream.getTracks().forEach(track => track.stop());
            });
          }
          return recording;
        }
      };
    } catch {
      return null;
    }
  }

  function blocked() {
    return new DOMException('Tap Resume Audio to allow the soundscape.', 'NotAllowedError');
  }

  function unlock() {
    // Creation and resume happen before yielding, preserving the click gesture.
    try {
      const audio = getContext();
      const resumed = audio.state === 'running' ? Promise.resolve() : audio.resume();
      return Promise.resolve(resumed).then(() => {
        if (audio.state !== 'running') throw blocked();
      });
    } catch (error) { return Promise.reject(error); }
  }

  function load(url) {
    if (!buffers.has(url)) {
      const loading = fetch(url).then(response => {
        if (!response.ok) throw new Error(`Could not load ambient audio (HTTP ${response.status}).`);
        return response.arrayBuffer();
      }).then(bytes => new Promise((resolve, reject) => {
        const decoded = getContext().decodeAudioData(bytes, resolve, reject);
        if (decoded && decoded.then) decoded.then(resolve, reject);
      })).catch(error => { buffers.delete(url); throw error; });
      buffers.set(url, loading);
    }
    return buffers.get(url);
  }

  function createSound() {
    let url = '', looping = false, volume = 1, offset = 0, startedAt = 0;
    let source = null, gain = null, buffer = null, pending = null, generation = 0;
    const listeners = new Set();

    function position() {
      const elapsed = offset + (source ? getContext().currentTime - startedAt : 0);
      if (!buffer) return elapsed;
      return looping ? elapsed % buffer.duration : Math.min(elapsed, buffer.duration);
    }

    function pause() {
      offset = position();
      generation++;
      pending = null;
      if (source) {
        const previous = source;
        source = null;
        previous.onended = null;
        previous.stop();
        previous.disconnect();
      }
    }

    function report(error) {
      for (const listener of listeners) listener.call(adapter, { type: 'error', target: adapter, error });
      throw error;
    }

    function play() {
      if (pending) return pending;
      const ready = unlock();
      if (source) return ready.catch(report);
      const run = ++generation;
      const requestedUrl = url;
      const operation = ready.then(() => load(requestedUrl)).then(decoded => {
        if (run !== generation) return;
        const audio = getContext();
        if (audio.state !== 'running') throw blocked();
        buffer = decoded;
        if (!gain) {
          gain = audio.createGain();
          gain.connect(getOutput());
        }
        gain.gain.value = volume;
        const next = audio.createBufferSource();
        next.buffer = buffer;
        next.loop = looping;
        next.connect(gain);
        offset = looping ? offset % buffer.duration : Math.min(offset, buffer.duration);
        startedAt = audio.currentTime;
        next.onended = () => {
          if (source !== next) return;
          offset = buffer.duration;
          source = null;
          next.disconnect();
        };
        next.start(0, offset);
        source = next;
      }).catch(error => {
        if (run !== generation) return;
        return report(error);
      }).finally(() => { if (pending === operation) pending = null; });
      pending = operation;
      return operation;
    }

    const adapter = {
      preload: 'none',
      get src() { return url; },
      set src(value) {
        const next = String(value);
        if (next === url) return;
        pause(); url = next; offset = 0; buffer = null;
      },
      get loop() { return looping; },
      set loop(value) { looping = Boolean(value); if (source) source.loop = looping; },
      get volume() { return volume; },
      set volume(value) {
        const numeric = Number(value);
        volume = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
        if (gain) gain.gain.value = volume;
      },
      get currentTime() { return position(); },
      set currentTime(value) {
        const resume = Boolean(source || pending);
        pause(); offset = Math.max(0, Number(value) || 0);
        if (resume) play().catch(() => {});
      },
      get paused() { return !source; },
      play,
      pause,
      addEventListener(type, listener) { if (type === 'error') listeners.add(listener); }
    };
    return adapter;
  }

  window.StillnessAudio = { supported: Boolean(Context), createSound, unlock, record, playVoice, setVoiceVolume };
})();
