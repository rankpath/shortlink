// Startup file for hosts that load the entry with require(), such as Plesk (Phusion Passenger).
// The app itself is an ES module (see package.json "type": "module"), so load it with import().
import('./server.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
