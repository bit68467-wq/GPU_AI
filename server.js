const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('.')); // serve HTML, JS, CSS

// --- Variabili ambiente per admin (mai visibili al frontend) ---
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'cup9gpuadmin@admincup';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Smokingbrown';

// --- Endpoint login admin ---
app.post('/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// --- Altri endpoint esistenti della piattaforma ---
// Inserisci qui eventuali endpoint che avevi già per utenti, dispositivi, prelievi, depositi ecc.
// Esempio:
// app.get('/users', ...)
// app.post('/deposit', ...)

// --- Avvio server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server attivo su http://localhost:${PORT}`));
