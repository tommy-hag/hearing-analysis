#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sqlite = require('../db/sqlite');

// Initialiser database
sqlite.init();

// Find alle publicerede høringer
const publishedHearingIds = new Set();

// Debug: Tjek hvad der er i tabellerne
console.log('Tjekker databasen for publicerede høringer...\n');

// Tjek alle høringer først
const allHearings = sqlite.db.prepare(`SELECT id, title FROM hearings ORDER BY id`).all();
console.log(`Total høringer i hearings tabel: ${allHearings.length}`);
allHearings.forEach(h => console.log(`  - Høring ${h.id}: ${h.title || '(ingen titel)'}`));

// Tjek prepared høringer
const preparedHearings = sqlite.listPreparedHearings();
console.log(`\nPrepared høringer: ${preparedHearings.length}`);
preparedHearings.forEach(h => {
    console.log(`  - Høring ${h.hearingId}: ${h.title || '(ingen titel)'}`);
    console.log(`    Status: ${h.preparation.status}, Published responses: ${h.counts.publishedResponses}, Prepared responses: ${h.counts.preparedResponses}`);
    console.log(`    Published at: ${h.preparation.publishedAt || 'null'}`);
    
    // Tilføj alle høringer med nogen form for data
    if (h.counts.publishedResponses > 0 || h.counts.preparedResponses > 0 || h.counts.rawResponses > 0 || h.preparation.publishedAt) {
        publishedHearingIds.add(Number(h.hearingId));
        console.log(`    ✅ Tilføjet til eksport (har data)`);
    }
});

// Hent fra hearing_preparation_state
const publishedFromState = sqlite.db.prepare(`
    SELECT DISTINCT hearing_id, published_at
    FROM hearing_preparation_state 
    WHERE published_at IS NOT NULL AND published_at > 0
`).all();
console.log(`hearing_preparation_state med published_at: ${publishedFromState.length}`);
publishedFromState.forEach(s => {
    publishedHearingIds.add(Number(s.hearing_id));
    console.log(`  - Høring ${s.hearing_id}, published_at: ${s.published_at}`);
});

// Hent fra published_responses
const publishedResponses = sqlite.db.prepare(`
    SELECT DISTINCT hearing_id, COUNT(*) as count
    FROM published_responses
    GROUP BY hearing_id
`).all();
console.log(`\npublished_responses: ${publishedResponses.length} høringer`);
publishedResponses.forEach(r => {
    publishedHearingIds.add(Number(r.hearing_id));
    console.log(`  - Høring ${r.hearing_id}: ${r.count} svar`);
});

// Hent fra published_materials
const publishedMaterials = sqlite.db.prepare(`
    SELECT DISTINCT hearing_id, COUNT(*) as count
    FROM published_materials
    GROUP BY hearing_id
`).all();
console.log(`\npublished_materials: ${publishedMaterials.length} høringer`);
publishedMaterials.forEach(m => {
    publishedHearingIds.add(Number(m.hearing_id));
    console.log(`  - Høring ${m.hearing_id}: ${m.count} materialer`);
});

// Opret published mappe
const publishedDir = path.join(__dirname, '..', 'published');
if (!fs.existsSync(publishedDir)) {
    fs.mkdirSync(publishedDir, { recursive: true });
    console.log(`Oprettet mappe: ${publishedDir}`);
}

// Tjek også JSON filer i data/hearings
const hearingsJsonDir = path.join(__dirname, '..', 'data', 'hearings');
if (fs.existsSync(hearingsJsonDir)) {
    const jsonFiles = fs.readdirSync(hearingsJsonDir).filter(f => f.endsWith('.json') && !f.includes('published'));
    console.log(`\nTjekker ${jsonFiles.length} JSON filer i data/hearings...`);
    
    for (const jsonFile of jsonFiles) {
        try {
            const filePath = path.join(hearingsJsonDir, jsonFile);
            const jsonData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const hearingId = jsonData.id || parseInt(jsonFile.replace('.json', ''));
            const responseCount = (jsonData.responses || []).length;
            
            // Tilføj høringer med responses til eksport
            if (responseCount > 0 && !publishedHearingIds.has(hearingId)) {
                publishedHearingIds.add(hearingId);
                console.log(`  ✅ Tilføjet høring ${hearingId} fra JSON (${responseCount} responses)`);
            }
        } catch (err) {
            console.log(`  ⚠️  Fejl ved læsning af ${jsonFile}: ${err.message}`);
        }
    }
}

// Hvis ingen fundet, tilføj alle høringer fra hearings tabel
if (publishedHearingIds.size === 0) {
    console.log(`\n⚠️  Ingen høringer med published/prepared data fundet.`);
    console.log(`Tjekker alle høringer i hearings tabel...`);
    allHearings.forEach(h => {
        publishedHearingIds.add(Number(h.id));
    });
    console.log(`Tilføjer alle ${allHearings.length} høringer til eksport for at tjekke data.`);
}

const hearingIds = Array.from(publishedHearingIds).sort((a, b) => a - b);

console.log(`\n📊 Total ${hearingIds.length} høringer til eksport: ${hearingIds.join(', ')}`);

// Eksporter hver høring
for (const hearingId of hearingIds) {
    console.log(`\nEksporterer høring ${hearingId}...`);
    
    // Hent høringsmetadata - først fra database, derefter fra JSON
    let hearing = sqlite.db.prepare(`SELECT * FROM hearings WHERE id=?`).get(hearingId);
    let jsonData = null;
    
    // Prøv altid at læse JSON fil hvis den eksisterer (den kan have mere data)
    const jsonPath = path.join(__dirname, '..', 'data', 'hearings', `${hearingId}.json`);
    if (fs.existsSync(jsonPath)) {
        try {
            jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            // Brug JSON data hvis høringen ikke findes i database, eller hvis JSON har bedre data
            if (!hearing) {
                hearing = {
                    id: jsonData.id || hearingId,
                    title: jsonData.title || jsonData.hearing?.title || `Høring ${hearingId}`,
                    start_date: jsonData.hearing?.startDate || jsonData.startDate || null,
                    deadline: jsonData.hearing?.deadline || jsonData.deadline || null,
                    status: jsonData.hearing?.status || jsonData.status || null,
                    updated_at: jsonData.updatedAt ? new Date(jsonData.updatedAt).getTime() : null
                };
                console.log(`  ℹ️  Hentet høring ${hearingId} fra JSON fil`);
            } else {
                // Opdater hearing med JSON data hvis JSON har bedre information
                if (jsonData.title && !hearing.title) hearing.title = jsonData.title;
                if (jsonData.hearing?.title && !hearing.title) hearing.title = jsonData.hearing.title;
            }
        } catch (err) {
            console.log(`  ⚠️  Fejl ved læsning af JSON fil: ${err.message}`);
        }
    }
    
    if (!hearing) {
        console.log(`  ⚠️  Høring ${hearingId} ikke fundet i database eller JSON filer`);
        continue;
    }
    
    // Hent publicerede data (hvis der er nogen)
    let publishedData = sqlite.getPublishedAggregate(hearingId);
    const hasPublishedData = publishedData && (publishedData.responses?.length > 0 || publishedData.materials?.length > 0);
    
    // Hvis ingen published data, prøv at hente prepared data i stedet
    let preparedData = null;
    let rawData = null;
    if (!hasPublishedData) {
        try {
            const bundle = sqlite.getPreparedBundle(hearingId);
            if (bundle && bundle.prepared) {
                preparedData = bundle.prepared;
                console.log(`  ℹ️  Ingen published data, bruger prepared data i stedet`);
            }
            if (bundle && bundle.raw) {
                rawData = bundle.raw;
                console.log(`  ℹ️  Tilføjer raw data`);
            }
        } catch (err) {
            // Ignorer fejl - prøv JSON i stedet
        }
        
        // Hvis stadig ingen data, prøv raw aggregate
        if (!preparedData && !rawData) {
            try {
                rawData = sqlite.getRawAggregate(hearingId);
                if (rawData && (rawData.responses?.length > 0 || rawData.materials?.length > 0)) {
                    console.log(`  ℹ️  Bruger raw data fra database`);
                } else {
                    rawData = null;
                }
            } catch (err) {
                // Ignorer fejl
            }
        }
        
        // Hvis stadig ingen data, prøv JSON fil (eller hvis JSON har mere data)
        if (jsonData && (!preparedData && !rawData || (jsonData.responses && jsonData.responses.length > 0))) {
            const responses = (jsonData.responses || []).map(r => ({
                id: r.id,
                text: r.text || '',
                textMd: r.text || '',
                author: r.author || null,
                respondentName: r.author || null,
                organization: r.organization || null,
                onBehalfOf: r.on_behalf_of || null,
                submittedAt: r.submitted_at || null,
                hasAttachments: Array.isArray(r.attachments) && r.attachments.length > 0,
                attachments: (r.attachments || []).map((a, idx) => ({
                    attachmentId: idx + 1,
                    filename: a.filename || a.title || `Bilag ${idx + 1}`,
                    url: a.url || null
                }))
            }));
            const materials = (jsonData.materials || []).map((m, idx) => ({
                materialId: idx + 1,
                type: m.type || null,
                title: m.title || 'Materiale',
                url: m.url || null,
                content: m.content || null
            }));
            
            if (responses.length > 0 || materials.length > 0) {
                rawData = { responses, materials };
                console.log(`  ℹ️  Bruger data fra JSON fil (${responses.length} responses, ${materials.length} materials)`);
            }
        }
    }
    
    // Hent preparation state
    const prepState = sqlite.getPreparationState(hearingId);
    
    // Saml alt data
    const exportData = {
        hearing: {
            id: hearing.id,
            title: hearing.title,
            startDate: hearing.start_date,
            deadline: hearing.deadline,
            status: hearing.status,
            updatedAt: hearing.updated_at,
            url: `https://blivhoert.kk.dk/hearing/${hearing.id}/comments`
        },
        preparation: prepState || null,
        published: hasPublishedData ? {
            responses: publishedData.responses || [],
            materials: publishedData.materials || [],
            responseCount: (publishedData.responses || []).length,
            materialCount: (publishedData.materials || []).length
        } : null,
        prepared: preparedData ? {
            responses: preparedData.responses || [],
            materials: preparedData.materials || [],
            responseCount: (preparedData.responses || []).length,
            materialCount: (preparedData.materials || []).length
        } : null,
        raw: rawData ? {
            responses: rawData.responses || [],
            materials: rawData.materials || [],
            responseCount: (rawData.responses || []).length,
            materialCount: (rawData.materials || []).length
        } : null,
        exportedAt: new Date().toISOString()
    };
    
    // Gem som JSON
    const filename = `hearing-${hearingId}.json`;
    const filepath = path.join(publishedDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(exportData, null, 2), 'utf8');
    
    console.log(`  ✅ Eksporteret til: ${filename}`);
    if (exportData.published) {
        console.log(`     - ${exportData.published.responseCount} publicerede svar`);
        console.log(`     - ${exportData.published.materialCount} publicerede materialer`);
    }
    if (exportData.prepared) {
        console.log(`     - ${exportData.prepared.responseCount} prepared svar`);
        console.log(`     - ${exportData.prepared.materialCount} prepared materialer`);
    }
    if (exportData.raw) {
        console.log(`     - ${exportData.raw.responseCount} raw svar`);
        console.log(`     - ${exportData.raw.materialCount} raw materialer`);
    }
    console.log(`     - Titel: ${hearing.title || '(ingen titel)'}`);
}

console.log(`\n✅ Eksport færdig! Alle filer er i: ${publishedDir}`);

