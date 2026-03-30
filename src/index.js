// Standalone entry point (used outside of Passenger, e.g. npm run dev)
const app = require('../app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
