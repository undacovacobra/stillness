(function () {
  'use strict';

  const databaseName = 'stillness-session-recordings';
  let databasePromise;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const sessions = db.createObjectStore('sessions', { keyPath: ['library', 'id'] });
        sessions.createIndex('byLibrary', 'library');
        db.createObjectStore('audio');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          databasePromise = undefined;
        };
        resolve(db);
      };
    }).catch(error => {
      databasePromise = undefined;
      throw error;
    });
    return databasePromise;
  }

  async function transact(stores, mode, run) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let request;
      tx.onabort = () => reject(tx.error || new Error('The recording could not be saved.'));
      tx.oncomplete = () => resolve(request?.result);
      try {
        request = run(tx);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }

  function save(library, entry, audio) {
    return transact(['sessions', 'audio'], 'readwrite', tx => {
      tx.objectStore('sessions').put({ ...entry, library });
      tx.objectStore('audio').put(audio, [library, entry.id]);
    });
  }

  function list(library) {
    return transact('sessions', 'readonly', tx => tx.objectStore('sessions').index('byLibrary').getAll(library));
  }

  function read(library, id) {
    return transact('audio', 'readonly', tx => tx.objectStore('audio').get([library, id]));
  }

  function remove(library, id) {
    return transact(['sessions', 'audio'], 'readwrite', tx => {
      tx.objectStore('sessions').delete([library, id]);
      tx.objectStore('audio').delete([library, id]);
    });
  }

  function capture(stream) {
    const Recorder = window.MediaRecorder;
    const types = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus'];
    const mimeType = types.find(type => Recorder.isTypeSupported?.(type));
    const recorder = new Recorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 96000 });
    const parts = [];
    let started = false;
    let finished = false;
    let resolveAudio;
    const audio = new Promise(resolve => { resolveAudio = resolve; });

    recorder.addEventListener('dataavailable', event => {
      if (event.data.size) parts.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      resolveAudio(parts.length ? new Blob(parts, { type: recorder.mimeType || parts[0].type }) : null);
      parts.length = 0;
    });
    recorder.addEventListener('error', () => {
      finished = true;
      resolveAudio(null);
    });

    return {
      setRunning(running) {
        if (finished) return;
        try {
          if (running && !started) {
            recorder.start(1000);
            started = true;
          } else if (running && recorder.state === 'paused') {
            recorder.resume();
          } else if (!running && recorder.state === 'recording') {
            recorder.pause();
          }
        } catch {
          this.finish();
        }
      },
      finish() {
        if (finished) return audio;
        finished = true;
        if (recorder.state !== 'inactive') {
          recorder.stop();
        } else {
          resolveAudio(null);
        }
        return audio;
      }
    };
  }

  function filename(title, type) {
    const safe = title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ').trim().replace(/\.+$/, '');
    const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    return `${safe || 'Stillness meditation'}.${extension}`;
  }

  window.StillnessRecordings = { capture, save, list, read, remove, filename };
})();
