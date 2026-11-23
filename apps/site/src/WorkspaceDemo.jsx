import { FileText, Folder, Play, X } from 'lucide-react';
import { useRef, useState } from 'react';

const exampleFiles = ['index.html', 'app.js', 'styles.css'];
const initialBooks = [
  { id: 1, title: 'A Wizard of Earthsea', read: true },
  { id: 2, title: 'Piranesi', read: false },
];

export function WorkspaceDemo({ icon }) {
  const preview = useRef(null);
  const [opened, setOpened] = useState(false);

  function openPreview() {
    setOpened(true);
    preview.current?.showModal();
  }

  return (
    <section className="workspace" aria-label="Miter workspace demo">
      <header className="workspace-bar">
        <div className="workspace-brand">
          <img src={icon} width="31" height="31" alt="" />
          <span>Miter</span>
        </div>
        <span className="workspace-project">
          <Folder size={20} aria-hidden="true" /> reading-list
        </span>
      </header>
      <div className="workspace-content">
        <h2>Build a reading list</h2>
        <ul className="file-list" aria-label="Changed files">
          {exampleFiles.map((file) => (
            <li key={file}>
              <FileText size={19} aria-hidden="true" />
              <span className="filename">{file}</span>
              <span className="file-state">Changed</span>
            </li>
          ))}
        </ul>
        <div className="workspace-actions">
          <span className="workspace-state">
            {!opened && 'Ready to run'}
            {opened && 'Preview ready'}
          </span>
          <button className="button primary" type="button" onClick={openPreview}>
            <Play size={17} aria-hidden="true" />
            {!opened && 'Run'}
            {opened && 'Open app'}
          </button>
        </div>
      </div>
      <div className="terminal">
        <p className="terminal-label">Terminal</p>
        <p className="terminal-output" role="status">
          {!opened && 'Waiting to open the preview.'}
          {opened && 'Reading list preview opened.'}
        </p>
      </div>
      <ReadingListPreview dialog={preview} />
    </section>
  );
}

function ReadingListPreview({ dialog }) {
  const titleInput = useRef(null);
  const nextBookId = useRef(initialBooks.length + 1);
  const [books, setBooks] = useState(initialBooks);
  const [invalidTitle, setInvalidTitle] = useState(false);

  function addBook(event) {
    event.preventDefault();
    const title = titleInput.current.value.trim();

    if (!title) {
      setInvalidTitle(true);
      titleInput.current.focus();
      return;
    }

    const newBook = { id: nextBookId.current, title, read: false };
    nextBookId.current += 1;
    setBooks((current) => [...current, newBook]);
    setInvalidTitle(false);
    event.currentTarget.reset();
    titleInput.current.focus();
  }

  function toggleBook(id) {
    setBooks((current) =>
      current.map((book) => {
        if (book.id === id) {
          return { ...book, read: !book.read };
        }

        return book;
      }),
    );
  }

  return (
    <dialog ref={dialog} className="demo-dialog" aria-labelledby="demo-title">
      <header className="demo-heading">
        <div>
          <p>Example app</p>
          <h2 id="demo-title">Reading list</h2>
        </div>
        <form method="dialog">
          <button className="button icon-button" aria-label="Close preview">
            <X size={20} aria-hidden="true" />
          </button>
        </form>
      </header>
      <form className="book-form" onSubmit={addBook} noValidate>
        <label htmlFor="book-title">Book title</label>
        <div className="book-field">
          <input
            ref={titleInput}
            id="book-title"
            name="title"
            placeholder="Enter a title"
            required
            maxLength={120}
            aria-invalid={invalidTitle}
            aria-describedby="book-error"
            onChange={() => setInvalidTitle(false)}
          />
          <button className="button primary">Add book</button>
        </div>
        <p id="book-error" className="book-error" role="alert" hidden={!invalidTitle}>
          Enter a book title.
        </p>
      </form>
      <ul className="reading-list">
        {books.map((book) => (
          <li key={book.id}>
            <label>
              <input type="checkbox" checked={book.read} onChange={() => toggleBook(book.id)} />
              <span>{book.title}</span>
            </label>
          </li>
        ))}
      </ul>
    </dialog>
  );
}
