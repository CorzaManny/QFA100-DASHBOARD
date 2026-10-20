// The sounds the ops panel makes: a ding for a message from the other side,
// and a ring for an incoming call.
//
// Both are built from oscillators rather than sound files, so there is nothing
// extra to cache and nothing to go missing offline. One audio context for the
// whole app: browsers only allow a handful, and a phone will not make a sound
// at all until the page has been touched once, which is what unlock() is for.

let ctx = null;

export function openAudio() {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// The first touch anywhere opens the audio, so the first sound the app wants to
// make is not the one that gets refused.
const unlock = () => {
  try {
    openAudio();
  } catch {
    // no audio on this device; nothing more to try
  }
  document.removeEventListener('pointerdown', unlock);
};
document.addEventListener('pointerdown', unlock);

// One note. Returns when it has been scheduled, not when it has finished.
function note(hz, at, length, volume) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = hz;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.05);
}

// A message from the other side. Two notes, high and short: it has to carry in
// a room with a simulator running in it without being a klaxon.
export function ding() {
  try {
    const c = openAudio();
    note(988, c.currentTime, 0.45, 0.16);
    note(1319, c.currentTime + 0.11, 0.45, 0.16);
  } catch {
    // not allowed yet; the unread badge still says there is something waiting
  }
}

// An incoming call: a pair of notes every two seconds until it is answered or
// it gives up. Deliberately more insistent than the ding, and lower, so the
// two are never mistaken for each other.
let ringing = null;

export function startRing() {
  if (ringing) return;
  const beat = () => {
    try {
      const c = openAudio();
      note(587, c.currentTime, 0.5, 0.2);
      note(784, c.currentTime + 0.22, 0.6, 0.2);
    } catch {
      // not allowed; the card on screen is still ringing
    }
  };
  beat();
  ringing = setInterval(beat, 2000);
}

export function stopRing() {
  if (!ringing) return;
  clearInterval(ringing);
  ringing = null;
}

// The far end hung up, or the call failed: one low note, so putting the phone
// down is audible without looking.
export function endTone() {
  try {
    const c = openAudio();
    note(440, c.currentTime, 0.35, 0.14);
  } catch {
    // not allowed; the card says the call has ended
  }
}
