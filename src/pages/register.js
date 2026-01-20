import { API } from "../api/endpoints.js";

export async function renderRegisterPage(root) {
  root.innerHTML = `
    <div class="card">
      <div class="h1">Player Registration</div>
      <div class="small">Register once to appear in the match dropdown.</div>
    </div>

    <div class="card">
      <input id="name" class="input" placeholder="Full name" />
      <input id="phone" class="input" placeholder="Phone (optional)" style="margin-top:10px" />
      <button id="btn" class="btn primary" style="margin-top:10px">Register</button>
      <div id="msg" class="small" style="margin-top:10px"></div>
    </div>
  `;

  const nameEl = root.querySelector("#name");
  const phoneEl = root.querySelector("#phone");
  const msgEl = root.querySelector("#msg");

  root.querySelector("#btn").onclick = async () => {
    msgEl.textContent = "Submitting...";
    const name = nameEl.value.replace(/\s+/g, " ").trim();
    const phone = phoneEl.value.trim();
    const res = await API.registerPlayer(name, phone);
    if (!res.ok) {
      msgEl.textContent = res.error || "Failed";
      return;
    }
    if (res.existing) {
      msgEl.textContent = "Already registered ✅ You can now select your name in match availability.";
    } else {
      msgEl.textContent = "Registered ✅ You can now select your name in match availability.";
    }
    nameEl.value = "";
    phoneEl.value = "";
  };
}