(() => {
  function pieces(text) {
    return text.trim().match(/.{1,240}(?:\s|$)|.{1,240}/gs)?.map(part => part.trim()).filter(Boolean) ?? [];
  }

  function create(chapters, request) {
    const plan = chapters.map(chapter => pieces(chapter.text));
    const offsets = [];
    const texts = [];
    for (const chapter of plan) {
      offsets.push(texts.length);
      texts.push(...chapter);
    }
    const controller = new AbortController();
    const clips = new Map();
    let queue = Promise.resolve();
    let playhead = 0;

    function load(index) {
      if (!clips.has(index)) {
        const pending = queue.then(() => {
          controller.signal.throwIfAborted();
          if (index < playhead) return null;
          return request(texts[index], controller.signal);
        }).catch(error => {
          clips.delete(index);
          throw error;
        });
        clips.set(index, pending);
        queue = pending.catch(() => {});
      }
      return clips.get(index);
    }

    return {
      count(chapter) { return plan[chapter].length; },
      clip(chapter, piece) { return load(offsets[chapter] + piece); },
      prefetch(chapter, piece) {
        playhead = offsets[chapter] + piece;
        for (const index of clips.keys()) if (index < playhead) clips.delete(index);
        for (let index = playhead + 1; index <= playhead + 3 && index < texts.length; index += 1) {
          void load(index).catch(() => {});
        }
      },
      stop() { controller.abort(); clips.clear(); },
    };
  }

  window.StillnessKokoro = { create };
})();
