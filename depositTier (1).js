/* === CUP9GPU FIXED DEVICE DEPOSIT SYSTEM & SELECTION ENFORCEMENT === */

/* Tier definitions */
window.CUP9GPU_TIERS = {
  MINI: { price: 60, daily: 0.66 },          // 1.1% of 60
  A:    { price: 160, daily: 1.76 },         // 1.1% of 160
  B:    { price: 220, daily: 2.42 },         // 1.1% of 220
  C:    { price: 380, daily: 4.18 },         // 1.1% of 380
  D:    { price: 700, daily: 7.70 },         // 1.1% of 700
  E:    { price: 1350, daily: 14.85 },       // 1.1% of 1350
  F:    { price: 2700, daily: 29.70 },       // 1.1% of 2700
  G:    { price: 3650, daily: 40.15 }        // 1.1% of 3650
};

/* Selected tier storage key */
window.SELECTED_TIER = localStorage.getItem('selectedTier') || null;

/* Select a tier programmatically (callable from device list buttons) */
window.selectTier = function (tierCode) {
  if (!window.CUP9GPU_TIERS[tierCode]) {
    throw new Error("Tier non valido");
  }

  window.SELECTED_TIER = tierCode;

  const amount = window.CUP9GPU_TIERS[tierCode].price;

  // if a deposit input is present on the page, set and lock it
  const input = document.querySelector("input[name='deposit']");
  if (input) {
    input.value = amount;
    input.setAttribute("readonly", "true");
  }

  localStorage.setItem("selectedTier", tierCode);
  localStorage.setItem("depositAmount", amount);
};

/* Validate deposit amount matches selected tier price exactly */
window.validateDeposit = function (amount) {
  const tier = window.SELECTED_TIER || localStorage.getItem("selectedTier");
  if (!tier) return false;
  return Number(amount) === Number(window.CUP9GPU_TIERS[tier].price);
};

/* Intercept deposit form submissions to enforce exact amount */
document.addEventListener("submit", function (e) {
  if (e.target && e.target.matches && e.target.matches(".deposit-form")) {
    const input = document.querySelector("input[name='deposit']");
    const amount = input ? Number(input.value) : NaN;

    if (!window.validateDeposit(amount)) {
      e.preventDefault();
      alert("Importo non valido. Il deposito deve corrispondere al dispositivo selezionato.");
    }
  }
});

/* === FORCE DEVICE SELECTION BEFORE NAVIGATING TO DEPOSIT === */

/* Adjust this to your device selection page route if different */
const DEVICE_PAGE_URL = "/devices.html";

/* Intercept clicks on deposit triggers and redirect to device page if no tier selected */
document.addEventListener("click", function (e) {
  const target = e.target;
  const btn = target.closest ? target.closest("[data-action='deposit'], .deposit-btn, #depositBtn") : null;
  if (!btn) return;

  // prevent default navigation if no selection and redirect user to device selection page
  if (!localStorage.getItem("selectedTier")) {
    e.preventDefault();
    window.location.href = DEVICE_PAGE_URL;
    return;
  }
  // otherwise, allow default behavior to proceed (form/button will continue)
});

/* Extra guard: if a deposit page uses .deposit-page body class, block direct access if no tier */
document.addEventListener("DOMContentLoaded", function () {
  const isDepositPage = document.body.classList.contains("deposit-page");
  if (isDepositPage && !localStorage.getItem("selectedTier")) {
    window.location.href = DEVICE_PAGE_URL;
  } else {
    // If deposit input exists and a tier is selected, enforce amount and readonly
    const input = document.querySelector("input[name='deposit']");
    const storedTier = localStorage.getItem("selectedTier");
    if (input && storedTier && window.CUP9GPU_TIERS[storedTier]) {
      input.value = window.CUP9GPU_TIERS[storedTier].price;
      input.setAttribute("readonly", "true");
    }
  }
});