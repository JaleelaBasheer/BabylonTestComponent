// // src/utils/indexedDBUtils.js

// import { openDB } from 'idb'; // Make sure to install `idb` package if not already installed

// const DB_NAME = 'MeshStorage';  //MeshStorage TestingStorage huldra20degree  Pipingdepth5 Pipingdepth8
// const DB_VERSION = 2;

// export const initDB = async () => {
//     try {
//         const db = await openDB(DB_NAME, DB_VERSION, {
//             upgrade(db, oldVersion, newVersion) {
//                 if (!db.objectStoreNames.contains('octree')) {
//                     db.createObjectStore('octree');
//                 }
//                 if (!db.objectStoreNames.contains('lowPolyMeshes')) {
//                     db.createObjectStore('lowPolyMeshes');
//                 }
//                 if (!db.objectStoreNames.contains('originalMeshes')) {
//                     db.createObjectStore('originalMeshes');
//                 }
//                 if (!db.objectStoreNames.contains('mergedlowPoly')) {
//                     db.createObjectStore('mergedlowPoly');
//                 }
//             },
//         });
//         return db;
//     } catch (error) {
//         console.error('Error initializing database:', error);
//         throw error;
//     }
// };


import { openDB } from 'idb';

const DB_NAME = 'huldrascreencoverage1'; //huldrascreencoverage0.2  Test12345678
const DB_VERSION = 1; // Incrementing version to handle new store
const TARGET_DEPTH = 4;

export const initDB = async () => {
    try {
        const db = await openDB(DB_NAME, DB_VERSION, {
            upgrade(db, oldVersion, newVersion) {
                if (!db.objectStoreNames.contains('octree')) {
                    db.createObjectStore('octree');
                }
                if (!db.objectStoreNames.contains('lowPolyMeshes')) {
                    db.createObjectStore('lowPolyMeshes');
                }
                if (!db.objectStoreNames.contains('originalMeshes')) {
                    db.createObjectStore('originalMeshes');
                }
                if (!db.objectStoreNames.contains('mergedlowPoly')) {
                    db.createObjectStore('mergedlowPoly');
                }
                if (!db.objectStoreNames.contains('mergedSkippedMeshes')) {
                    db.createObjectStore('mergedSkippedMeshes');
                }
            },
        });
        return db;
    } catch (error) {
        console.error('Error initializing database:', error);
        throw error;
    }
};
