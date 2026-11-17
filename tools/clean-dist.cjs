const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(process.cwd(), 'dist');
const keep = 'qqnt-anti-recall-0.3.0+snowlora.3.zip';
for (const name of fs.readdirSync(dir)) {
  if (name.endsWith('.zip') && name !== keep) {
    fs.unlinkSync(path.join(dir, name));
    console.log('removed', name);
  }
}
console.log('remaining:', fs.readdirSync(dir).filter(n => n.endsWith('.zip')));
