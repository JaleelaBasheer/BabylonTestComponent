const TARGET_DEPTH =4;

export function findNodeByNumber(block, targetNodeNumber, depth = 0) {
    if (block.properties.nodeNumber === targetNodeNumber) {
        return block;
    }
    
    if (depth < TARGET_DEPTH && block.relationships?.childBlocks) {
        for (const child of block.relationships.childBlocks) {
            const found = findNodeByNumber(child, targetNodeNumber, depth + 1);
            if (found) return found;
        }
    }
    return null;
}