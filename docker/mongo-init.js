'use strict';

// One-node replica set so the API can commit the job and the outbox row
// in a single MongoDB transaction. `mongo` is the hostname other containers use.
// This file runs inside mongosh (`mongosh --file`), not Node.js.

let initiated = false;
try {
  const status = rs.status();
  initiated = status.ok === 1;
} catch (error) {
  initiated = false;
}

if (!initiated) {
  rs.initiate({
    _id: 'rs0',
    members: [{ _id: 0, host: 'mongo:27017' }],
  });
}

let ready = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const hello = db.adminCommand({ hello: 1 });
    if (hello.isWritablePrimary) {
      ready = true;
      break;
    }
  } catch (error) {
    // The set is still electing a primary.
  }
  sleep(500);
}

if (!ready) {
  quit(1);
}

quit(0);
