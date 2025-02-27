export const findNodeInOctree = (octreeData, targetNodeNumber) => {
    if (!octreeData || !octreeData.blockHierarchy) return null;
  
    const traverse = (node) => {
      // Check current node
      if (node.properties?.nodeNumber === targetNodeNumber) {
        return node;
      }
  
      // Check children
      if (node.relationships?.childBlocks) {
        for (const child of node.relationships.childBlocks) {
          const found = traverse(child);
          if (found) return found;
        }
      }
      return null;
    };
  
    return traverse(octreeData.blockHierarchy);
  };