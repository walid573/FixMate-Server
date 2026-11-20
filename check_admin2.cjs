const { MongoClient } = require('mongodb');
(async () => {
  const url = 'mongodb://fixmate:cPJd0lUrz9ZEmzr7@ac-qylvfvb-shard-00-00.fukpcba.mongodb.net:27017/?ssl=true';
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db('fixmate');

  const users = db.collection('users');
  const services = db.collection('services');
  const bookings = db.collection('bookings');

  const u = await users.find({}).toArray();
  console.log('users:', u.length);
  u.forEach(x => console.log(' -', x.email, x.role, x.name));

  const s = await services.find({}).toArray();
  console.log('services:', s.length);
  const pending = s.filter(x => x.approvalStatus === 'pending');
  console.log('pending services:', pending.length);
  pending.forEach(x => console.log(' -', x.title, x.technicianName, x.basePrice, x.approvalStatus));

  const b = await bookings.find({}).toArray();
  console.log('bookings:', b.length);
  b.forEach(x => console.log(' -', x.serviceTitle, x.customerName, x.technicianName, x.status, x.paymentStatus));

  await client.close();
})();