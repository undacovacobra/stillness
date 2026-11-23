const campaign = new URLSearchParams(location.search);
for (const link of document.querySelectorAll('[data-app-link]')) {
  const destination = new URL(link.href);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) {
    const value = campaign.get(key);
    if (value && value.length <= 100) destination.searchParams.set(key, value);
  }
  link.href = destination.pathname + destination.search;
}

const player = document.getElementById('sample-audio');
const play = document.getElementById('sample-play');
const state = document.getElementById('sample-state');
const time = document.getElementById('sample-time');
const feedback = document.getElementById('sample-feedback');
player.hidden = true;
play.hidden = false;

function updatePlayback() {
  const playing = !player.paused && !player.ended;
  play.toggleAttribute('data-playing', playing);
  play.setAttribute('aria-label', playing ? 'Pause the bedtime meditation sample' : 'Play the bedtime meditation sample');
  state.textContent = playing ? 'Playing bedtime sample' : 'Bedtime sample';
}

play.addEventListener('click', async () => {
  feedback.textContent = '';
  if (!player.paused) {
    player.pause();
    return;
  }
  try {
    await player.play();
  } catch (error) {
    if (error.name === 'AbortError') return;
    state.textContent = 'Sample unavailable. Try again.';
    feedback.textContent = state.textContent;
  }
});
for (const event of ['play', 'pause', 'ended']) player.addEventListener(event, updatePlayback);
player.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(player.duration)) time.textContent = '0:' + String(Math.floor(player.duration)).padStart(2, '0');
});
