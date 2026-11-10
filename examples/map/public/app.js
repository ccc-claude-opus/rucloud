// Leaflet 地圖 + 釘選 CRUD
const map = L.map('map').setView([25.0385, 121.5595], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const list = document.getElementById('list');
const form = document.getElementById('form');
const markers = new Map(); // id -> { data, leaflet }
let pending = null; // 待存的新釘選座標

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

function popupHtml(m) {
  const esc = (s) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '\u0026amp;', '<': '\u0026lt;', '>': '\u0026gt;', '"': '\u0026quot;' }[c]));
  return `<b>${esc(m.title)}</b>${m.note ? `<br>${esc(m.note)}` : ''}<br>
    <a href="#" onclick="removeMarker(${m.id});return false">刪除</a>`;
}

function addMarker(m, { pan = false } = {}) {
  const leaflet = L.marker([m.lat, m.lng]).addTo(map).bindPopup(popupHtml(m));
  markers.set(m.id, { data: m, leaflet });
  const li = document.createElement('li');
  li.dataset.id = m.id;
  li.innerHTML = `<button class="del" title="刪除">✕</button><div class="t"></div><div class="n"></div>`;
  li.querySelector('.t').textContent = m.title;
  li.querySelector('.n').textContent = m.note || `${m.lat.toFixed(4)}, ${m.lng.toFixed(4)}`;
  li.onclick = (e) => {
    if (e.target.classList.contains('del')) return;
    map.panTo([m.lat, m.lng]);
    leaflet.openPopup();
  };
  li.querySelector('.del').onclick = () => removeMarker(m.id);
  list.prepend(li);
  if (pan) map.panTo([m.lat, m.lng]);
}

async function removeMarker(id) {
  await api(`/api/markers/${id}`, { method: 'DELETE' });
  markers.get(id)?.leaflet.remove();
  markers.delete(id);
  list.querySelector(`li[data-id="${id}"]`)?.remove();
  stats();
}
window.removeMarker = removeMarker;

async function stats() {
  const s = await api('/api/stats');
  document.getElementById('stats').textContent =
    `　目前 ${s.total} 個釘選（緯度 ${s.minLat}～${s.maxLat}、經度 ${s.minLng}～${s.maxLng}）`;
}

map.on('click', (e) => {
  pending = { lat: e.latlng.lat, lng: e.latlng.lng };
  document.getElementById('form-coord').textContent =
    `${pending.lat.toFixed(5)}, ${pending.lng.toFixed(5)}`;
  form.classList.remove('hidden');
  document.getElementById('title').focus();
});

document.getElementById('cancel').onclick = () => {
  pending = null;
  form.classList.add('hidden');
};

document.getElementById('save').onclick = async () => {
  const title = document.getElementById('title').value;
  const note = document.getElementById('note').value;
  if (!pending || !title.trim()) return;
  const m = await api('/api/markers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...pending, title, note }),
  });
  addMarker(m, { pan: true });
  pending = null;
  form.classList.add('hidden');
  document.getElementById('title').value = '';
  document.getElementById('note').value = '';
  stats();
};

form.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') document.getElementById('save').click();
  if (e.key === 'Escape') document.getElementById('cancel').click();
});

(async () => {
  const { markers: rows } = await api('/api/markers');
  for (const m of rows) addMarker(m);
  stats();
})();
