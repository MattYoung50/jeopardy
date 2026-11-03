import { newId } from '../utils/id';
import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Board, Category, Question, FinalJeopardyBoard, Round } from '@shared/types';
import FinalJeopardyEditor from '../components/final/FinalJeopardyEditor';
import { hostFetch } from '../lib/hostAuth';

const API = '/api';

function newQuestion(value: number): Question {
  return { id: newId(), value, clue: '', response: '' };
}
function newCategory(pointValues: number[]): Category {
  return { id: newId(), name: '', questions: pointValues.map(newQuestion) };
}
function newRound(categoryCount: number, pointValues: number[], name?: string): Round {
  return {
    id: newId(),
    name,
    categories: Array.from({ length: categoryCount }, () => newCategory(pointValues)),
    pointValues,
  };
}
function duplicateRound(round: Round, doubleValues: boolean): Round {
  const pointValues = doubleValues ? round.pointValues.map(v => v * 2) : [...round.pointValues];
  return {
    id: newId(),
    name: round.name,
    pointValues,
    categories: round.categories.map(cat => ({
      id: newId(),
      name: cat.name,
      questions: cat.questions.map((q, i) => ({ ...q, id: newId(), value: pointValues[i] ?? q.value })),
    })),
  };
}

export default function Editor() {
  const { boardId } = useParams<{ boardId: string }>();
  const navigate = useNavigate();
  const [board, setBoard] = useState<Board | null>(null);
  const [roundIdx, setRoundIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<{ catIdx: number; qIdx: number } | null>(null);
  const [editingFinal, setEditingFinal] = useState(false);

  useEffect(() => {
    fetch(`${API}/boards/${boardId}`)
      .then(r => r.json())
      .then(setBoard);
  }, [boardId]);

  const save = useCallback(async (b: Board) => {
    setSaving(true);
    await hostFetch(`${API}/boards/${b.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, []);

  if (!board) return <div className="flex items-center justify-center h-screen text-gray-400">Loading...</div>;

  const round = board.rounds[roundIdx] ?? board.rounds[0];

  function updateRound(fn: (r: Round) => Round) {
    const rounds = [...board!.rounds];
    rounds[roundIdx] = fn(rounds[roundIdx]);
    setBoard({ ...board!, rounds });
  }

  function addCategory() {
    updateRound(r => ({ ...r, categories: [...r.categories, newCategory(r.pointValues)] }));
  }

  function removeCategory(idx: number) {
    if (!confirm('Remove this category?')) return;
    updateRound(r => ({ ...r, categories: r.categories.filter((_, i) => i !== idx) }));
  }

  function updateCategoryName(idx: number, name: string) {
    updateRound(r => {
      const cats = [...r.categories];
      cats[idx] = { ...cats[idx], name };
      return { ...r, categories: cats };
    });
  }

  function updateQuestion(catIdx: number, qIdx: number, updates: Partial<Question>) {
    updateRound(r => {
      const cats = [...r.categories];
      const qs = [...cats[catIdx].questions];
      qs[qIdx] = { ...qs[qIdx], ...updates };
      cats[catIdx] = { ...cats[catIdx], questions: qs };
      return { ...r, categories: cats };
    });
  }

  function updatePointValue(i: number, value: number) {
    updateRound(r => {
      const pv = [...r.pointValues];
      pv[i] = value;
      const cats = r.categories.map(cat => ({
        ...cat,
        questions: cat.questions.map((q, qi) => qi === i ? { ...q, value } : q),
      }));
      return { ...r, pointValues: pv, categories: cats };
    });
  }

  function addRow() {
    updateRound(r => {
      const newVal = (r.pointValues[r.pointValues.length - 1] ?? 0) + 200;
      const pv = [...r.pointValues, newVal];
      const cats = r.categories.map(cat => ({ ...cat, questions: [...cat.questions, newQuestion(newVal)] }));
      return { ...r, pointValues: pv, categories: cats };
    });
  }

  function renameRound(name: string) {
    updateRound(r => ({ ...r, name }));
  }

  function addRound() {
    const prev = board!.rounds[board!.rounds.length - 1];
    const pointValues = prev.pointValues.map(v => v * 2);
    const name = board!.rounds.length === 1 ? 'Double Jeopardy!' : undefined;
    const rounds = [...board!.rounds, newRound(prev.categories.length, pointValues, name)];
    setBoard({ ...board!, rounds });
    setRoundIdx(rounds.length - 1);
  }

  function duplicateCurrentRound(doubleValues: boolean) {
    const rounds = [...board!.rounds];
    rounds.splice(roundIdx + 1, 0, duplicateRound(round, doubleValues));
    setBoard({ ...board!, rounds });
    setRoundIdx(roundIdx + 1);
  }

  function moveRound(dir: -1 | 1) {
    const target = roundIdx + dir;
    if (target < 0 || target >= board!.rounds.length) return;
    const rounds = [...board!.rounds];
    [rounds[roundIdx], rounds[target]] = [rounds[target], rounds[roundIdx]];
    setBoard({ ...board!, rounds });
    setRoundIdx(target);
  }

  function removeRound() {
    if (board!.rounds.length <= 1) return;
    if (!confirm('Remove this round? This cannot be undone.')) return;
    const rounds = board!.rounds.filter((_, i) => i !== roundIdx);
    setBoard({ ...board!, rounds });
    setRoundIdx(Math.max(0, roundIdx - 1));
  }

  function saveFinalJeopardy(fj: FinalJeopardyBoard) {
    const b = { ...board!, finalJeopardy: fj };
    setBoard(b);
    save(b);
  }

  function removeFinalJeopardy() {
    const b = { ...board!, finalJeopardy: undefined };
    setBoard(b);
    save(b);
  }

  const activeQ = editingQuestion != null
    ? round.categories[editingQuestion.catIdx]?.questions[editingQuestion.qIdx]
    : null;

  return (
    <div className="min-h-screen bg-jeopardy-dark flex flex-col">
      {/* Top bar */}
      <div className="bg-gray-900 border-b border-gray-700 px-4 py-3 flex items-center gap-4">
        <button onClick={() => navigate('/')} className="text-gray-400 hover:text-white">← Back</button>
        <input
          className="input-field max-w-sm text-lg font-bold"
          value={board.name}
          onChange={e => setBoard({ ...board, name: e.target.value })}
          placeholder="Board name"
        />
        <div className="ml-auto flex gap-3 items-center">
          {saved && <span className="text-green-400 text-sm">✓ Saved</span>}
          <button
            className={`btn-ghost text-sm ${board.finalJeopardy ? 'bg-jeopardy-gold text-jeopardy-dark' : ''}`}
            onClick={() => setEditingFinal(true)}
          >
            ⚡ Final Jeopardy{board.finalJeopardy ? ' ✓' : ''}
          </button>
          <button className="btn-primary" onClick={() => save(board)} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button className="btn-ghost" onClick={() => navigate(`/host/${board.id}`)}>▶ Host Game</button>
        </div>
      </div>

      {/* Round tabs */}
      <div className="px-4 py-2 bg-gray-900 border-b border-gray-800 flex gap-2 items-center flex-wrap">
        {board.rounds.map((r, i) => (
          <button
            key={r.id}
            onClick={() => setRoundIdx(i)}
            className={`text-sm px-3 py-1 rounded font-bold transition-colors ${i === roundIdx ? 'bg-jeopardy-gold text-jeopardy-dark' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
          >
            {r.name || `Round ${i + 1}`}
          </button>
        ))}
        <button className="text-sm text-gray-400 hover:text-white px-2" onClick={addRound}>+ Add round</button>
        <div className="ml-auto flex gap-2 items-center">
          <input
            className="w-40 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white"
            placeholder="Round name"
            value={round.name ?? ''}
            onChange={e => renameRound(e.target.value)}
          />
          <button className="text-xs text-gray-400 hover:text-white px-2 py-1" onClick={() => moveRound(-1)} disabled={roundIdx === 0}>←</button>
          <button className="text-xs text-gray-400 hover:text-white px-2 py-1" onClick={() => moveRound(1)} disabled={roundIdx === board.rounds.length - 1}>→</button>
          <button className="text-xs text-gray-400 hover:text-white px-2 py-1" onClick={() => duplicateCurrentRound(false)}>Duplicate</button>
          <button className="text-xs text-gray-400 hover:text-white px-2 py-1" onClick={() => duplicateCurrentRound(true)}>Duplicate ×2</button>
          <button
            className="text-xs text-red-400 hover:text-red-200 px-2 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={removeRound}
            disabled={board.rounds.length <= 1}
          >Remove round</button>
        </div>
      </div>

      {/* Point values row */}
      <div className="px-4 py-2 bg-gray-900 border-b border-gray-800 flex gap-2 items-center">
        <span className="text-gray-400 text-sm mr-2">Point values:</span>
        {round.pointValues.map((v, i) => (
          <input
            key={i}
            type="number"
            className="w-20 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-jeopardy-gold text-center text-sm"
            value={v}
            onChange={e => updatePointValue(i, Number(e.target.value))}
          />
        ))}
        <button className="text-sm text-gray-400 hover:text-white ml-2" onClick={addRow}>+ Add row</button>
      </div>

      {/* Board grid */}
      <div className="flex-1 overflow-auto p-4">
        <div className="overflow-x-auto">
          <table className="border-collapse w-full" style={{ minWidth: `${Math.max(round.categories.length, 1) * 160}px` }}>
            <thead>
              <tr>
                {round.categories.map((cat, ci) => (
                  <th key={cat.id} className="p-1">
                    <div className="relative">
                      <input
                        className="w-full bg-jeopardy-blue border-4 border-black text-jeopardy-gold font-black text-center py-3 px-2 uppercase text-sm focus:outline-none focus:border-jeopardy-gold"
                        value={cat.name}
                        onChange={e => updateCategoryName(ci, e.target.value)}
                        placeholder="CATEGORY"
                      />
                      <button
                        className="absolute top-1 right-1 text-red-400 hover:text-red-200 text-xs"
                        onClick={() => removeCategory(ci)}
                      >✕</button>
                    </div>
                  </th>
                ))}
                <th className="p-1 w-12">
                  <button
                    className="w-full bg-gray-800 border-2 border-dashed border-gray-600 text-gray-400 hover:text-white hover:border-gray-400 py-3 px-2 text-2xl font-bold transition-colors"
                    onClick={addCategory}
                  >+</button>
                </th>
              </tr>
            </thead>
            <tbody>
              {round.pointValues.map((pv, qi) => (
                <tr key={qi}>
                  {round.categories.map((cat, ci) => {
                    const q = cat.questions[qi];
                    if (!q) return <td key={ci} />;
                    const hasContent = q.clue || q.response || q.mediaUrl;
                    return (
                      <td key={cat.id} className="p-1">
                        <button
                          className={`w-full aspect-video flex flex-col items-center justify-center border-4 border-black font-black text-xl transition-all hover:brightness-125 relative
                            ${hasContent ? 'bg-jeopardy-blue text-jeopardy-gold' : 'bg-gray-800 border-dashed border-gray-600 text-gray-500'}`}
                          style={{ minHeight: 80 }}
                          onClick={() => setEditingQuestion({ catIdx: ci, qIdx: qi })}
                        >
                          <span>{pv}</span>
                          {q.isDailyDouble && (
                            <span className="absolute top-1 right-1 text-xs bg-yellow-500 text-black px-1 rounded">DD</span>
                          )}
                          {q.mediaType && (
                            <span className="absolute bottom-1 right-1 text-xs">
                              {q.mediaType === 'image' ? '🖼' : q.mediaType === 'video' ? '🎬' : '▶'}
                            </span>
                          )}
                        </button>
                      </td>
                    );
                  })}
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Question editor panel */}
      {editingQuestion && activeQ && (
        <QuestionEditor
          question={activeQ}
          onChange={updates => updateQuestion(editingQuestion.catIdx, editingQuestion.qIdx, updates)}
          onClose={() => { save(board); setEditingQuestion(null); }}
        />
      )}

      {editingFinal && (
        <FinalJeopardyEditor
          finalJeopardy={board.finalJeopardy}
          onSave={saveFinalJeopardy}
          onRemove={removeFinalJeopardy}
          onClose={() => setEditingFinal(false)}
        />
      )}
    </div>
  );
}

function QuestionEditor({
  question, onChange, onClose
}: {
  question: Question;
  onChange: (u: Partial<Question>) => void;
  onClose: () => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function handleFileUpload(file: File) {
    setUploading(true);
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await hostFetch('/api/media/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Upload failed');
      onChange({ mediaType: data.mediaType, mediaUrl: data.url });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border-2 border-jeopardy-gold rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-xl font-bold text-jeopardy-gold">${question.value} Question</h2>
          <button className="text-gray-400 hover:text-white text-2xl" onClick={onClose}>✕</button>
        </div>

        <div className="p-4 space-y-4">
          {/* Clue */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Clue (shown to contestants)</label>
            <textarea
              className="input-field h-24 resize-none"
              placeholder="This is the clue displayed on screen..."
              value={question.clue}
              onChange={e => onChange({ clue: e.target.value })}
            />
          </div>

          {/* Response */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Response (correct answer)</label>
            <input
              className="input-field"
              placeholder="What is...?"
              value={question.response}
              onChange={e => onChange({ response: e.target.value })}
            />
          </div>

          {/* Media */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">Media (optional)</label>
            <div className="flex gap-2 mb-3 flex-wrap">
              <label className={`btn-ghost text-sm py-1 px-3 cursor-pointer ${uploading ? 'opacity-50' : ''}`}>
                {uploading ? 'Uploading...' : '📁 Upload Image/Video'}
                <input
                  type="file"
                  className="hidden"
                  accept="image/*,video/*"
                  disabled={uploading}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); }}
                />
              </label>
              <button
                className="btn-ghost text-sm py-1 px-3"
                onClick={() => onChange({ mediaType: 'youtube', mediaUrl: '' })}
              >▶ YouTube URL</button>
              {question.mediaUrl && (
                <button
                  className="btn-danger text-sm py-1 px-3"
                  onClick={() => onChange({ mediaType: undefined, mediaUrl: undefined })}
                >Remove Media</button>
              )}
            </div>

            {question.mediaType === 'youtube' && (
              <input
                className="input-field"
                placeholder="https://www.youtube.com/watch?v=..."
                value={question.mediaUrl ?? ''}
                onChange={e => onChange({ mediaUrl: e.target.value })}
              />
            )}

            {question.mediaUrl && question.mediaType === 'image' && (
              <img src={question.mediaUrl} alt="preview" className="max-h-40 rounded border border-gray-600 mt-2" />
            )}
            {question.mediaUrl && question.mediaType === 'video' && (
              <video src={question.mediaUrl} controls className="max-h-40 rounded border border-gray-600 mt-2 w-full" />
            )}
            {question.mediaUrl && question.mediaType === 'youtube' && (
              <div className="mt-2 text-sm text-gray-400">YouTube video will be embedded during the game.</div>
            )}
          </div>

          {/* Daily Double */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="w-5 h-5 accent-yellow-400"
              checked={!!question.isDailyDouble}
              onChange={e => onChange({ isDailyDouble: e.target.checked })}
            />
            <span className="text-yellow-400 font-bold">Daily Double</span>
          </label>
        </div>
      </div>
    </div>
  );
}
