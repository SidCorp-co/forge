'use client';

import { useBoard } from './hooks';
import { BoardView } from './components';

export default function BoardPage() {
  const boardState = useBoard();
  return <BoardView {...boardState} />;
}
