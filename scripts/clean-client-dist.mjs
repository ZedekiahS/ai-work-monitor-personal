import fs from 'node:fs';import path from 'node:path';
const target=path.resolve('dist');if(path.dirname(target)!==process.cwd())throw Error('Unexpected output path');fs.rmSync(target,{recursive:true,force:true});
