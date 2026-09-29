// A small page for checking Palm's phone previews and hot reload.
const app = document.querySelector("#app");
app.innerHTML = `
  <h1>Palm preview demo</h1>
  <p class="lede">This page runs on the Mac and opens on the phone at the phone's real size.</p>
  <p class="meta">Viewport: <span id="viewport"></span></p>
`;
const report = () => {
  document.querySelector("#viewport").textContent = `${window.innerWidth} × ${window.innerHeight} CSS px`;
};
report();
window.addEventListener("resize", report);
