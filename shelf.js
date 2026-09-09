'use strict';

const vscode = require('vscode');
const path = require('path');

/**
 * The shelf tree in the activity-bar view: lists known books with their saved
 * progress; clicking opens the book at that position.
 */
class ShelfProvider {
  constructor(getBooks, onOpen) {
    this.getBooks = getBooks;     // () => { absPath: {line} }
    this.onOpen = onOpen;         // (absPath) => void
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }

  refresh() { this._onDidChange.fire(); }

  getTreeItem(element) { return element; }

  getChildren() {
    const books = this.getBooks();
    const keys = Object.keys(books);
    return keys.map(p => {
      const item = new vscode.TreeItem(path.basename(p));
      item.description = `第 ${(books[p].line || 0) + 1} 行`;
      item.tooltip = p;
      item.iconPath = new vscode.ThemeIcon('book');
      item.command = { command: 'moreoverReader.openPath', title: '打开', arguments: [p] };
      item.contextValue = 'moreoverBook';
      item.path = p;
      return item;
    });
  }
}

module.exports = { ShelfProvider };
