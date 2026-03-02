const fs = require('fs');

const file = 'output/checkpoints/223/test13/job_223_1764278578860_load-data.json';
// Note: I need to find the correct path. 
// The list_dir showed files in output/checkpoints/223/test13/
// Let's check if the file exists there.
// The list_dir output for test13 showed:
// job_223_1764278578860_load-data.json (113705 bytes)

const path = 'output/checkpoints/223/test13/load-data.json';

try {
    const data = fs.readFileSync(path, 'utf8');
    const json = JSON.parse(data);

    // Assuming it's an array or has a key with the array
    if (Array.isArray(json)) {
        console.log(`Array length: ${json.length}`);
    } else if (json.data && Array.isArray(json.data)) {
        console.log(`json.data length: ${json.data.length}`);
    } else if (json.responses && Array.isArray(json.responses)) {
        console.log(`json.responses length: ${json.responses.length}`);
    } else {
        console.log("Structure:", Object.keys(json));
        // If it's an object with numbered keys or something
    }
} catch (e) {
    console.error(e);
}
